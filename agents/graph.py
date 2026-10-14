"""LangGraph ticket-triage graph.

    START -> main_agent (Laya labelling + routing)
                |-- "highways"  -> highways_agent
                |-- "electric"  -> electric_agent
                |-- "hydro"     -> hydro_agent
                |-- "sanitation"-> sanitation_agent
           -> main_answer (main agent composes the final reply) -> END

The main agent owns two steps: layer-1 labelling (local Laya, calibrated probabilities) and
the final answer that reconciles the department sub-agent's work order with those labels.
"""
from __future__ import annotations

import json
import time
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

from .config import DEPARTMENTS, DEPARTMENT_KEYS, FREE_MODELS, GROQ_API_KEY, GROQ_BASE_URL, sla_for
from .laya_labeler import Labels, label_ticket, needs_multilingual
from .sub_agents import chat_json


class TicketState(TypedDict, total=False):
    text: str
    meta: dict
    labels: dict
    route: str
    sub_agent: dict
    final: dict
    trace: Annotated[list[str], lambda a, b: a + b]  # every node appends instead of overwriting


# --------------------------------------------------------------------------- main agent
def main_agent(state: TicketState) -> dict:
    """Layer 1: label the raw ticket with the local Laya checkpoint and pick a sub-agent."""
    labels = label_ticket(state["text"])
    trace = [
        f"main_agent -> Laya ({labels.source}, {labels.label_ms} ms): "
        f"{labels.department} {labels.department_confidence:.2f} | {labels.priority} | "
        f"urgent={labels.urgent_probability}",
    ]
    return {"labels": labels.to_dict(), "route": labels.department, "trace": trace}


def route_sub_agent(state: TicketState) -> str:
    route = state.get("route", "highways")
    return route if route in DEPARTMENT_KEYS else "highways"


def _sub_agent_node(dept: str):
    def node(state: TicketState) -> dict:
        labels = Labels(**state["labels"])
        from .sub_agents import run_sub_agent

        trace: list[str] = []
        out = run_sub_agent(dept, labels, trace)
        return {"sub_agent": out, "trace": trace}

    return node


# ---------------------------------------------------------------------- main final answer
FINAL_SYSTEM = (
    "You are the MAIN AGENT of UrbanFix, a LangGraph ticket-triage system for Chennai civic "
    "infrastructure. A local calibrated classifier (Laya) labelled the ticket, then exactly one "
    "department sub-agent produced a work order. Reconcile the two and issue the final answer. "
    "If the sub-agent's priority/SLA contradicts the Laya labels without good reason, keep the "
    "Laya labels - they are the calibrated source of truth. Write every field in English unless "
    "the ticket itself is written in another language, in which case mirror the ticket's "
    "language for citizen_reply only. Keep every string field to at most "
    "25 words and the whole object under 600 tokens. Answer with ONE JSON object only "
    "(no prose, no markdown fences):\n"
    "{\n"
    '  "docket_title": "<max 60 chars>",\n'
    '  "department_key": "<highways|electric|hydro|sanitation>",\n'
    '  "dept_label": "<municipal department>",\n'
    '  "category": "<citizen-facing category>",\n'
    '  "defect_type": "<technical defect>",\n'
    '  "priority": "P1" | "P2" | "P3",\n'
    '  "sla_hours": <int>,\n'
    '  "routing_reason": "<1-2 sentences: why this ticket went to this sub-agent>",\n'
    '  "dispatch_brief": "<what the field crew must do, 2-3 sentences>",\n'
    '  "escalation_notes": "<1-2 sentences for the nodal officer>",\n'
    '  "citizen_reply": "<warm, plain-language reply to the citizen, same language as the ticket>"\n'
    "}"
)


def _match_reply_language(ticket: str, reply: str) -> str:
    """Deterministic language guard for `citizen_reply`.

    The LLM occasionally answers an English ticket in Tamil (and vice versa), even though the
    prompt says to mirror the ticket's language. The reply is what the citizen actually reads,
    so enforce the rule here: one cheap re-ask, and if that still mismatches an English ticket
    gets an empty reply rather than one in a language the citizen did not write in.
    """
    if not reply:
        return reply
    ticket_nonlatin = needs_multilingual(ticket)
    reply_nonlatin = needs_multilingual(reply)
    if ticket_nonlatin == reply_nonlatin:
        return reply

    want = "the same language as the ticket (write it in that script)" if ticket_nonlatin else "English"
    try:
        fixed, _, _ = chat_json(
            "You rewrite civic replies. Answer with ONE JSON object only, no prose: "
            '{"citizen_reply": "..."}',
            f"Rewrite the reply below in {want}. Keep it under 40 words, same meaning, "
            f"warm and plain-language, nothing else.\n\n"
            f"TICKET:\n{ticket}\n\nREPLY (wrong language):\n{reply}",
            FREE_MODELS["fast"],
            max_tokens=300,
        )
        text = str(fixed.get("citizen_reply") or "").strip()
        if text and needs_multilingual(text) == ticket_nonlatin:
            return text
    except Exception:
        pass
    # Non-Latin ticket: keep the original as a best effort. Latin ticket: drop it rather
    # than show Tamil text to someone who wrote in English.
    return reply if ticket_nonlatin else ""


def main_answer(state: TicketState) -> dict:
    """Final step: the main agent answers, merging Laya labels with the sub-agent work order."""
    labels = state["labels"]
    sub = state.get("sub_agent", {})
    if not GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY is not set - add it to .env")

    user = (
        "RAW TICKET\n"
        f"{state['text']}\n\n"
        "LAYER-1 LABELS (Laya, local)\n"
        f"{json.dumps(labels, indent=2)}\n\n"
        "SUB-AGENT WORK ORDER\n"
        f"{json.dumps(sub, indent=2)}\n\n"
        "Issue the final answer as JSON."
    )
    final, usage, used_model = chat_json(FINAL_SYSTEM, user, FREE_MODELS["heavy"])

    # The main agent is authoritative on routing: it owns the label the graph routed on.
    dept = labels["department"]
    final.setdefault("department_key", dept)
    final["department_key"] = dept
    final["dept_label"] = labels["dept_label"]
    final["category"] = labels["category"]
    final["priority"] = labels["priority"]
    final["sla_hours"] = sla_for(dept, labels["priority"])
    final["defect_type"] = final.get("defect_type") or sub.get("defect_type") or "Public Hazard"
    final["docket_title"] = (final.get("docket_title") or state["text"])[:60]
    # Never emit a hole: borrow from the sub-agent when the main agent's reply was terse.
    steps = sub.get("field_instructions") or []
    final["routing_reason"] = final.get("routing_reason") or sub.get("reasoning") or ""
    final["dispatch_brief"] = final.get("dispatch_brief") or ("; ".join(steps) if steps else "")
    final["escalation_notes"] = final.get("escalation_notes") or sub.get("risk_if_delayed") or ""
    final["citizen_reply"] = _match_reply_language(
        state["text"], final.get("citizen_reply") or sub.get("citizen_reply") or ""
    )
    final["confidence"] = labels["department_confidence"]
    final["label_source"] = labels["source"]
    final["sub_agent_model"] = sub.get("model")
    final["main_model"] = used_model

    trace = [
        f"main_answer -> {used_model} "
        f"({usage.get('prompt_tokens', '?')} tok in, "
        f"{usage.get('completion_tokens', '?')} tok out)"
    ]
    return {"final": final, "trace": trace}


# ------------------------------------------------------------------------------- builder
def _build():
    b = StateGraph(TicketState)
    b.add_node("main_agent", main_agent)
    for dept in DEPARTMENT_KEYS:
        b.add_node(f"{dept}_agent", _sub_agent_node(dept))
    b.add_node("main_answer", main_answer)

    b.add_edge(START, "main_agent")
    b.add_conditional_edges(
        "main_agent",
        route_sub_agent,
        {dept: f"{dept}_agent" for dept in DEPARTMENT_KEYS},
    )
    for dept in DEPARTMENT_KEYS:
        b.add_edge(f"{dept}_agent", "main_answer")
    b.add_edge("main_answer", END)
    return b.compile()


triage_graph = _build()


def run_ticket(text: str, meta: dict | None = None, verbose: bool = False) -> dict:
    """Run the whole graph. Returns labels + route + sub-agent output + the main agent's answer."""
    t0 = time.perf_counter()
    state: TicketState = {"text": text, "meta": meta or {}}
    if verbose:
        state["trace"] = []
    result = triage_graph.invoke(state)
    out = {
        "route": result.get("route"),
        "labels": result.get("labels"),
        "sub_agent": result.get("sub_agent"),
        "final": result.get("final"),
        "trace": result.get("trace", []),
        "elapsed_ms": int((time.perf_counter() - t0) * 1000),
    }
    return out
