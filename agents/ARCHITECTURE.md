# UrbanFix Agent Architecture

LangGraph ticket-triage system: a **main agent** that labels tickets with the local **Laya**
checkpoint, routes to **one of four department sub-agents**, then answers as the main agent
again.

```
START ──► main_agent ──► (conditional route by department) ──┐
           layer 1: Laya labels                              ├─► highways_agent  ─┐
                                                             ├─► electric_agent  ─┤
                                                             ├─► hydro_agent     ─┼─► main_answer ──► END
                                                             └─► sanitation_agent─┘   layer 3: final reply
```

---

## 1. Inventory — every agent in the system

| # | Node | Role | Model / runtime |
|---|------|------|-----------------|
| 1 | `main_agent` (layer 1) | Label the raw ticket: department, priority, urgency | **Local Laya** RL-Agent, offline, CPU (~1.7–2.0 s) |
| 2 | `highways_agent` | Road-surface work order | `openai/gpt-oss-120b` (Groq free) |
| 3 | `electric_agent` | Electrical-hazard work order | `openai/gpt-oss-120b` (Groq free) |
| 4 | `hydro_agent` | Water/sewerage work order | `openai/gpt-oss-20b` (Groq free) |
| 5 | `sanitation_agent` | Solid-waste work order | `openai/gpt-oss-20b` (Groq free) |
| 6 | `main_answer` (layer 3) | Reconcile labels + work order, issue the final answer | `openai/gpt-oss-120b`, fallback `mistral:ministral-8b-latest` |

Only **6 nodes**, **1 router**, **5 LLM/label calls** per ticket (1 local + 2 remote).

---

## 2. Main agent

### Layer 1 — `main_agent` (local Laya, no LLM, no API cost)

Loads the vendored checkpoint in `./laya` (ModernBERT-large encoder + decision heads, 803 MB,
built offline from `encoder/config.json` — no HuggingFace download). It asks **three typed
questions** in one forward pass and returns **calibrated** probabilities (trained with RLCD
against strictly proper scoring rules, so the probabilities are trustworthy):

| Question | Type | Options | Used for |
|---|---|---|---|
| `department` | `choice` | highways / electric / hydro / sanitation | **the routing decision** |
| `severity` | `score` | P3 routine · P2 moderate · P1 critical | priority + SLA |
| `urgent` | `noul` | false / true | life-safety escalation |

Question text given to Laya:

> **department** — *"Route this civic complaint ticket to exactly one municipal department.
> Reply with the department whose scope covers the reported defect."*
> - `highways`: Road surface, potholes, asphalt, footpath, kerb, lane marking, cave-in, road works
> - `electric`: Street light, lamp, cable, transformer, sparking, shock, power outage, TANGEDCO
> - `hydro`: Water pipe, leakage, burst, sewage, drain, manhole, waterlogging, gutter, CMWSSB
> - `sanitation`: Garbage, waste bin, overflowing dump, dead animal, sweeping, mosquito, debris
>
> **severity** — *"Rate how urgent this ticket is for the municipal dispatch queue."*
> **urgent** — *"Does this ticket describe an immediate danger to life or safety?"*

Rules applied after inference:
- `argmax(probabilities)` → department (the edge the router takes)
- `round(severity_score)` → `P3 | P2 | P1`
- `urgent >= 0.7` **escalates to P1** even if severity said P2
- any exception (torch missing, bad weights) → **keyword fallback labeller**, graph never breaks

### Layer 3 — `main_answer` (the main agent speaks last)

Receives the raw ticket + Laya labels + the sub-agent work order, and issues the final answer.

> **System prompt (actual):**
> *"You are the MAIN AGENT of UrbanFix, a LangGraph ticket-triage system for Chennai civic
> infrastructure. A local calibrated classifier (Laya) labelled the ticket, then exactly one
> department sub-agent produced a work order. Reconcile the two and issue the final answer.
> If the sub-agent's priority/SLA contradicts the Laya labels without good reason, **keep the
> Laya labels — they are the calibrated source of truth**. Write every field in English unless
> the ticket itself is written in another language, in which case mirror the ticket's language
> for `citizen_reply` only. Keep every string field to at most 25 words and the whole object
> under 600 tokens. Answer with ONE JSON object only — no prose, no markdown fences."*

Output schema: `docket_title`, `department_key`, `dept_label`, `category`, `defect_type`,
`priority`, `sla_hours`, `routing_reason`, `dispatch_brief`, `escalation_notes`, `citizen_reply`.

The main agent is **authoritative on routing**: after the LLM replies it re-stamps
`department_key / dept_label / category / priority / sla_hours` from the Laya labels, and fills
any hole from the sub-agent (`routing_reason ← reasoning`, `dispatch_brief ← field_instructions`,
`citizen_reply ← sub-agent's reply`). No field can come back empty.

---

## 3. The four sub-agents

Shared system prompt (each prepends its own identity):

> *"You are one node of a LangGraph ticket-triage graph for UrbanFix (Chennai civic
> infrastructure). A local calibrated classifier (Laya) has already labelled the ticket; **trust
> its department, priority and SLA unless the ticket text clearly contradicts it**. Write in
> English unless the ticket itself is in another language; `citizen_reply` mirrors the ticket's
> language, every other field stays in English. Keep `field_instructions` to at most 4 short
> steps and the whole object under 500 tokens. Answer with ONE JSON object only."*

Output schema: `department`, `dept_label`, `category`, `defect_type`, `priority`, `sla_hours`,
`title`, `reasoning`, `field_instructions[]`, `required_crew`, `risk_if_delayed`, `citizen_reply`.

Each sub-agent also receives the **layer-1 labels as input** (department, full probability
distribution, priority, severity score, urgent probability, SLA) plus its department scope.

| Sub-agent | Identity line | Scope it owns | Base SLA | Model |
|---|---|---|---|---|
| `highways_agent` | *"You are the HIGHWAYS sub-agent of UrbanFix … Greater Chennai Corporation (GCC) Works / Highways"* | potholes, asphalt craters, rutting, damaged footpaths/covers, kerbstones, lane markings, crash barriers, cave-ins, encroachment | 4 h | gpt-oss-120b |
| `electric_agent` | *"You are the ELECTRICAL sub-agent … TANGEDCO / Electrical Works"* | sparking/flickering streetlights, dead luminaires, exposed HT/LT cables, damaged transformers, energised poles, shock risk, earthing | 2 h | gpt-oss-120b |
| `hydro_agent` | *"You are the HYDRO sub-agent … CMWSSB / Water & Sewerage"* | potable-water leaks/bursts, valve & coupling failure, sewage overflow, blocked drains, waterlogging, contamination | 6 h | gpt-oss-20b |
| `sanitation_agent` | *"You are the SANITATION sub-agent … Zonal Solid Waste Management"* | overflowing bins, uncollected garbage, debris dumps, dead animals, sweeping failures, mosquito breeding | 8 h | gpt-oss-20b |

Behavioural instructions baked into each identity:
- **highways** — name the repair method (cut-and-fill patch / cold mix / full-depth reclaim), crew, traffic-management step, SLA
- **electric** — treat every live-electric report as life-safety: **isolation/de-energising step first**, then repair
- **hydro** — prioritise contamination and waterlogging public-health risk before hydraulics
- **sanitation** — cover public-health risk, clearance plan, and the frequency fix so it doesn't recur

---

## 4. Flow, step by step

1. **Citizen types** a complaint (React form) → debounced `POST /api/label` every ~0.9 s shows
   the inferred department + SLA live in the UI.
2. **Submit** → `POST /api/triage` runs the whole graph.
3. **`main_agent`** labels the ticket with local Laya → `{department, priority, urgent,
   probabilities}` → writes `labels` + `route` into state.
4. **Conditional edge** `route_sub_agent(state)` returns one of `highways | electric | hydro |
   sanitation` → exactly one sub-agent node executes (the other three never run).
5. **Sub-agent** builds a domain work order (JSON) with its free model.
6. **`main_answer`** reconciles Laya labels with the work order and writes the final reply.
7. **END** → API returns flat fields for the UI (`route`, `deptLabel`, `priority`, `slaHours`,
   `defectType`, `citizenReply`, `dispatchBrief`…) plus full `labels / subAgent / final / trace`.

### Graph state

```python
class TicketState(TypedDict, total=False):
    text: str
    meta: dict
    labels: dict                                   # written by main_agent (layer 1)
    route: str                                     # written by main_agent
    sub_agent: dict                                # written by the routed sub-agent
    final: dict                                    # written by main_answer
    trace: Annotated[list[str], lambda a, b: a + b]  # append reducer — every node logs
```

### Routing + SLA maths

```python
priority   = round(laya.severity_score)      # 0→P3, 1→P2, 2→P1
priority   = "P1" if laya.urgent >= 0.7 else priority
sla_hours  = base_sla[department] * {"P1": 1, "P2": 2, "P3": 4}[priority]
# highways 4h · electric 2h · hydro 6h · sanitation 8h
```

---

## 5. Models & providers (all free tier)

| Provider | Models | Used when |
|---|---|---|
| **Groq** | `openai/gpt-oss-120b` (heavy), `openai/gpt-oss-20b` (fast), `qwen/qwen3.8-27b` (available) | primary |
| **Mistral** | `ministral-8b-latest` (`codestral-latest` also responds) | Groq 429 / truncated JSON |
| **Local Laya** | vendored checkpoint in `./laya` | every label, always |

`chat_json()` walks a provider plan — *Groq primary → Mistral → Groq fallback → Groq primary* —
with 1.5 s backoff, and retries anything that isn't parseable JSON. Truncated output is repaired
by brace-balancing (`_balance`), then retried. Output budget is **900 tokens** (Groq free tier
caps at 1000 output tokens/min on some models). A graph node therefore never fails on one flaky
completion.

Keys live in `.env` (gitignored): `GROQ_API_KEY`, `MISTRAL_API_KEY`.

---

## 6. Serving layer

| Piece | Where | Notes |
|---|---|---|
| `agents/graph.py` | LangGraph `StateGraph`, compiled → `triage_graph` | also callable in-process |
| `agents/server.py` | FastAPI, `:8010` | `GET /api/health`, `POST /api/label`, `POST /api/triage`; Laya warmed at startup; CORS open for Vite |
| `agents/laya_labeler.py` | Laya wrapper + keyword fallback | |
| `agents/sub_agents.py` | 4 domain prompts, provider chain, JSON repair | |
| `src/services/triageApi.ts` | typed frontend client | every call optional — UI degrades to keyword inference if the API is down |
| `agents/dashboard.py` | Streamlit sim dashboard, `:8501` | live API **or** in-process mode, pipeline DAG, probability chart, 4 tabs, history |
| `agents/cli.py` / `check.py` | terminal runner / 4-route smoke test | `python -m agents.check` |

```bash
npm.cmd run agents:api          # :8010  (Laya warms ~30 s)
npm.cmd run dev                 # :3000
npm.cmd run agents:dashboard    # :8501
npm.cmd run agents:check        # verify all 4 routes
python -m agents.cli "deep pothole on Avenue Road" --json
```

---

## 7. Failure handling (why nothing dies mid-demo)

| Failure | Behaviour |
|---|---|
| torch / Laya weights missing | `keyword_label()` fallback, graph still routes |
| Groq 429 (output-token limit) | backoff → Mistral → other Groq model |
| Truncated / non-JSON reply | brace-balance repair → retry on next provider |
| Sub-agent omits a field | filled from Laya labels / sub-agent payload |
| API unreachable from UI | frontend keeps its local keyword inference; ticket still files |
| Dashboard, API down | switch to **in-process** mode and run the graph directly |
