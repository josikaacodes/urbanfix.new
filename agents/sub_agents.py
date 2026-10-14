"""Department sub-agents. Each one is a Groq free-tier model with a domain system prompt."""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request

from groq import Groq

from .config import (
    DEPARTMENTS,
    FREE_MODELS,
    GROQ_API_KEY,
    GROQ_BASE_URL,
    MISTRAL_API_KEY,
    MISTRAL_BASE_URL,
    MISTRAL_MODEL,
    sla_for,
)
from .laya_labeler import Labels

_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)

# Free tier enforces 1000 output tokens/min on some models - stay just under it.
MAX_OUTPUT_TOKENS = 900

SYSTEM_SUFFIX = (
    "You are one node of a LangGraph ticket-triage graph for UrbanFix (Chennai civic "
    "infrastructure). A local calibrated classifier (Laya) has already labelled the ticket; "
    "trust its department, priority and SLA unless the ticket text clearly contradicts it.\n"
    "Write in English unless the ticket itself is in another language; citizen_reply mirrors the "
    "ticket's language, every other field stays in English. Keep every string field to at most "
    "25 words, field_instructions to at most 4 short steps, and the whole object under 600 "
    "tokens.\n"
    "Answer with ONE JSON object only - no prose, no markdown fences - matching:\n"
    '{\n'
    '  "department": "<internal key>",\n'
    '  "dept_label": "<municipal department>",\n'
    '  "category": "<category shown to citizens>",\n'
    '  "defect_type": "<specific technical defect>",\n'
    '  "priority": "P1" | "P2" | "P3",\n'
    '  "sla_hours": <integer>,\n'
    '  "title": "<max 60 char docket title>",\n'
    '  "reasoning": "<2-3 sentences on why this is the correct routing>",\n'
    '  "field_instructions": ["<step>", "..."],\n'
    '  "required_crew": "<crew type + equipment>",\n'
    '  "risk_if_delayed": "<1 sentence>",\n'
    '  "citizen_reply": "<plain-language, respectful reply to the citizen in the ticket language>"\n'
    "}"
)


def _client() -> Groq:
    if not GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY is not set - add it to .env")
    return Groq(api_key=GROQ_API_KEY, base_url=GROQ_BASE_URL)


def _balance(text: str) -> str:
    """Close an object whose output was cut off mid-generation (unclosed braces/strings)."""
    out, stack, in_str, esc = [], [], False, False
    for ch in text:
        out.append(ch)
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if stack:
                stack.pop()
    if in_str:
        out.append('"')
    out.extend(reversed(stack))
    return "".join(out)


def _parse_json(raw: str) -> dict:
    m = _JSON_FENCE.search(raw)
    if m:
        raw = m.group(1)
    start = raw.find("{")
    if start == -1:
        raise ValueError(f"no JSON object in reply: {raw[:200]!r}")
    body = raw[start:]
    end = body.rfind("}")
    body = body[: end + 1] if end != -1 else _balance(body)
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return json.loads(_balance(body))  # trailing commas / truncation rescue


def _mistral_call(model: str, system: str, user: str, max_tokens: int):
    """OpenAI-compatible call to Mistral (stdlib only - no extra dependency)."""
    if not MISTRAL_API_KEY:
        raise RuntimeError("MISTRAL_API_KEY is not set - add it to .env")
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0.2,
            "max_tokens": max_tokens,
        }
    ).encode()
    req = urllib.request.Request(
        f"{MISTRAL_BASE_URL}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {MISTRAL_API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.load(resp)
    content = payload["choices"][0]["message"].get("content") or ""
    usage = payload.get("usage") or {}
    return content, {"prompt_tokens": usage.get("prompt_tokens", 0),
                     "completion_tokens": usage.get("completion_tokens", 0)}


def chat_json(system: str, user: str, model: str, max_tokens: int = MAX_OUTPUT_TOKENS):
    """Run one LLM call and return (parsed_json, usage, model_used).

    Provider order: the requested Groq free model -> Mistral (generous free quota) -> the
    other Groq free model. Rate limits (429) and truncated/non-JSON replies walk down the
    chain instead of failing the graph.
    """
    fallback = FREE_MODELS["fast"]
    plan: list[tuple[str, str]] = [("groq", model), ("mistral", MISTRAL_MODEL)]
    if model != fallback:
        plan.append(("groq", fallback))
    plan.append(("groq", model))  # one last try back on the primary model
    last_err: Exception | None = None

    for idx, (provider, use_model) in enumerate(plan):
        try:
            if provider == "groq":
                resp = _client().chat.completions.create(
                    model=use_model,
                    temperature=0.2,
                    max_tokens=max_tokens,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                )
                content = resp.choices[0].message.content or ""
                usage = {
                    "prompt_tokens": getattr(resp.usage, "prompt_tokens", 0) or 0,
                    "completion_tokens": getattr(resp.usage, "completion_tokens", 0) or 0,
                }
                label = f"groq:{use_model}"
            else:
                content, usage = _mistral_call(use_model, system, user, max_tokens)
                label = f"mistral:{use_model}"
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 503):
                raise
            last_err = exc
            time.sleep(1.0 + idx)
            continue
        except Exception as exc:
            if "429" not in str(exc) and "rate_limit" not in str(exc):
                raise
            last_err = exc
            time.sleep(1.0 + idx)
            continue

        try:
            return _parse_json(content), usage, label
        except (ValueError, json.JSONDecodeError) as exc:  # truncated -> try the next provider
            last_err = exc
            time.sleep(0.5)

    raise RuntimeError(f"all LLM providers failed after {len(plan)} attempts: {last_err}")


def run_sub_agent(dept: str, labels: Labels, trace: list[str] | None = None) -> dict:
    """Route the ticket to the department specialist and get its structured work order back."""
    if dept not in DEPARTMENTS:
        raise KeyError(f"Unknown department {dept!r}; expected one of {list(DEPARTMENTS)}")

    meta = DEPARTMENTS[dept]
    user = (
        "TICKET\n"
        f"{labels.text}\n\n"
        "LAYER-1 LABELS (Laya, local calibrated classifier)\n"
        f"department={labels.department}  confidence={labels.department_confidence}\n"
        f"probabilities={json.dumps(labels.probabilities)}\n"
        f"priority={labels.priority}  severity_score={labels.severity_score}\n"
        f"urgent_probability={labels.urgent_probability}\n"
        f"sla_hours={labels.sla_hours}\n\n"
        f"DEPARTMENT SCOPE: {meta['scope']}\n"
        f"DEPARTMENT: {meta['dept_label']} ({meta['category']})\n"
        "Produce the JSON work order now."
    )

    out, usage, used_model = chat_json(meta["system"] + "\n\n" + SYSTEM_SUFFIX, user, meta["model"])

    # Fill gaps from the layer-1 labels so the graph output is always complete even if the
    # model omitted a field (truncated output, or a short reply from the small Mistral model).
    out.setdefault("department", dept)
    out.setdefault("dept_label", meta["dept_label"])
    out.setdefault("category", meta["category"])
    out.setdefault("reasoning", "")
    out.setdefault("risk_if_delayed", "")
    out.setdefault("citizen_reply", "")
    out.setdefault("field_instructions", [])
    out["priority"] = out.get("priority") or labels.priority
    out["sla_hours"] = int(out.get("sla_hours") or sla_for(dept, out["priority"]))
    out.setdefault("required_crew", meta["crew"])
    out["model"] = used_model

    if trace is not None:
        trace.append(
            f"{dept}_agent -> {used_model} "
            f"({usage.get('prompt_tokens', '?')} tok in, "
            f"{usage.get('completion_tokens', '?')} tok out)"
        )
    return out
