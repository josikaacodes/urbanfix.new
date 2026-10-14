"""Streamlit sim dashboard for the UrbanFix agent endpoints.

    npm run agents:dashboard      ->  http://localhost:8501

Talks to the HTTP API by default (POST /api/triage, POST /api/label, GET /api/health).
If the API is down you can flip the mode switch to run the LangGraph pipeline in-process,
so a demo never dies mid-presentation.
"""
from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request
from datetime import datetime

import pandas as pd
import streamlit as st

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DEFAULT_API = "http://127.0.0.1:8010"

DEPT_META = {
    "highways": ("GCC Works / Highways", "Roads & Potholes"),
    "electric": ("TANGEDCO / Electrical Works", "Electricity & Grid"),
    "hydro": ("CMWSSB / Water & Sewerage", "Water & Drainage"),
    "sanitation": ("Zonal Solid Waste Management", "Sanitation & Waste"),
}

SAMPLES = {
    "Road pothole": (
        "highways",
        'Deep 8-inch pothole crater expanding on the primary bus lane near Metro Pillar 18. '
        "Two-wheelers are swerving into the opposite oncoming traffic lane to avoid it.",
    ),
    "Sparking streetlight": (
        "electric",
        "Streetlight pole luminaire sparking and flickering above the school crosswalk after rain. "
        "The pedestrian crossing is pitch dark at night and children use it to reach school.",
    ),
    "Burst water main": (
        "hydro",
        "Underground pressurized potable water pipe coupling has ruptured on Market Link Road. "
        "Clean drinking water is flooding the pavement and eroding the road foundation.",
    ),
    "Overflowing garbage": (
        "sanitation",
        "Secondary garbage container overflowed onto the footpath at the market west gate. "
        "Commercial organic waste is giving off a foul odour and blocking the sidewalk.",
    ),
}


# --------------------------------------------------------------------------- HTTP helpers
def api_get(base: str, path: str, timeout: float = 5.0):
    with urllib.request.urlopen(f"{base}{path}", timeout=timeout) as resp:
        return json.load(resp)


def api_post(base: str, path: str, payload: dict, timeout: float = 180.0):
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def normalize_api(data: dict) -> dict:
    """API response -> the same shape run_ticket() returns in-process."""
    return {
        "route": data.get("route"),
        "labels": data.get("labels") or {},
        "sub_agent": data.get("subAgent") or {},
        "final": data.get("final") or {},
        "trace": data.get("trace") or [],
        "elapsed_ms": data.get("elapsedMs"),
        "mode": "live api",
        "flat": data,
    }


def run_in_process(text: str, meta: dict) -> dict:
    from agents.graph import run_ticket  # lazy: torch + Laya load on first use

    out = run_ticket(text, meta=meta)
    out["mode"] = "in-process"
    out["flat"] = {}
    return out


# --------------------------------------------------------------------------- page chrome
st.set_page_config(page_title="UrbanFix Agent Console", page_icon="🧭", layout="wide")

st.markdown(
    """
    <style>
      .block-container { padding-top: 1.4rem; }
      div[data-testid="stMetric"] { background:#f7f3ea; border:1px solid #c2c8c255;
        border-radius:12px; padding:.6rem .8rem; }
      div[data-testid="stMetricValue"] { font-size:1.5rem; }
    </style>
    """,
    unsafe_allow_html=True,
)

with st.sidebar:
    st.markdown("### ⚙️ Endpoint")
    api_base = st.text_input("Agent API", value=DEFAULT_API)
    mode = st.radio("Pipeline mode", ["live api", "in-process"], horizontal=False)

    health = None
    try:
        health = api_get(api_base, "/api/health")
        st.success(f"API online · port {api_base.rsplit(':', 1)[-1]}")
    except Exception as exc:
        st.error(f"API unreachable: {type(exc).__name__}")
        if mode == "live api":
            st.info("Switch to **in-process** to run the graph locally instead.")

    if health:
        st.markdown("**Graph**")
        st.code(health.get("graph", ""), language="text")
        st.markdown("**Free models**")
        for name, model in (health.get("free_models") or {}).items():
            st.write(f"- `{name}` → `{model}`")
        st.markdown(f"**Laya checkpoint** — {'✅ loaded' if health['laya']['loaded'] else '❌ not loaded'}")
        st.caption(f"`{health['laya']['dir']}`")

    st.markdown("---")
    st.caption("main_agent (Laya labels) → 1 of 4 sub-agents → main_answer")

st.title("UrbanFix · Agent Triage Console")
st.caption("Sim dashboard over `/api/label` and `/api/triage` — Laya-labelled main agent, four department sub-agents, main agent composes the answer.")

# ------------------------------------------------------------------------------ inputs
sample_name = st.selectbox("Sample ticket", list(SAMPLES) + ["Custom"], index=0)
default_dept, default_text = SAMPLES.get(sample_name, ("", ""))

col_in, col_loc = st.columns([3, 1])
with col_in:
    text = st.text_area("Citizen ticket", value=default_text, height=130)
with col_loc:
    location = st.text_input("Location", value="Ward 42, Chennai")
    st.caption(f"Expected route: `{default_dept or '—'}`")

run = st.button("▶ Run triage", type="primary", width="stretch")

if run:
    if not text.strip():
        st.warning("Enter a ticket first.")
    else:
        try:
            with st.status("Running: main_agent → sub-agent → main_answer", expanded=True) as status:
                st.write("1/3 · **main_agent** — local Laya labelling")
                if mode == "live api":
                    raw = api_post(api_base, "/api/triage", {"text": text, "meta": {"location": location}})
                    result = normalize_api(raw)
                else:
                    result = run_in_process(text, {"location": location})
                st.write("2/3 · **sub-agent** — routed by label")
                st.write("3/3 · **main_answer** — final reply")
                status.update(label=f"done in {result.get('elapsed_ms', '?')} ms", state="complete")
            st.session_state["result"] = result
            st.session_state.setdefault("history", []).insert(
                0,
                {
                    "time": datetime.now().strftime("%H:%M:%S"),
                    "route": result.get("route"),
                    "priority": (result.get("final") or {}).get("priority"),
                    "sla_h": (result.get("final") or {}).get("sla_hours"),
                    "conf": round((result.get("labels") or {}).get("department_confidence", 0), 2),
                    "ms": result.get("elapsed_ms"),
                    "mode": result.get("mode"),
                },
            )
        except Exception as exc:
            st.error(f"Triage failed: {type(exc).__name__}: {exc}")

# ------------------------------------------------------------------------------- output
result = st.session_state.get("result")
if not result:
    st.info("Pick a sample ticket and hit **Run triage**.")
    st.stop()

labels = result.get("labels") or {}
sub = result.get("sub_agent") or {}
final = result.get("final") or {}
flat = result.get("flat") or {}
route = result.get("route") or labels.get("department")

# --- pipeline graph --------------------------------------------------------------
dept_label, category = DEPT_META.get(route, ("—", "—"))
dot = """
digraph triage {
  rankdir=LR; bgcolor="transparent";
  main [label="main_agent\\n(Laya labels)", shape=box, style="rounded,filled", fillcolor="#1a3125", fontcolor=white];
  ans  [label="main_answer\\n(final reply)", shape=box, style="rounded,filled", fillcolor="#1a3125", fontcolor=white];
"""
for key, (lbl, _cat) in DEPT_META.items():
    on = key == route
    dot += (
        f'  {key} [label="{lbl}", shape=box, style="rounded,filled", fillcolor="{"#c9e4cc" if on else "#ece8df"}", '
        f'fontcolor="{"#051c11" if on else "#8a908c"}", color="{"#1a3125" if on else "#c2c8c2"}"];\n'
    )
    dot += f'  main -> {key} [style="{"solid" if on else "dotted"}", penwidth={3 if on else 1}];\n'
    dot += f'  {key} -> ans [style="{"solid" if on else "dotted"}", penwidth={3 if on else 1}];\n'
dot += "}"

gl, gr = st.columns([1, 1])
with gl:
    st.graphviz_chart(dot)
with gr:
    m1, m2, m3 = st.columns(3)
    m1.metric("Routed to", route.upper() if route else "—", dept_label)
    m2.metric("Priority", final.get("priority") or labels.get("priority") or "—",
              f"SLA {final.get('sla_hours') or labels.get('sla_hours')} h")
    m3.metric("Confidence", f"{(labels.get('department_confidence') or 0) * 100:.1f}%",
              labels.get("source", ""))
    m4, m5, m6 = st.columns(3)
    m4.metric("Total time", f"{result.get('elapsed_ms', 0)} ms", result.get("mode", ""))
    m5.metric("Laya label time", f"{labels.get('label_ms', 0)} ms", "cpu, offline")
    m6.metric("Urgent prob.", f"{(labels.get('urgent_probability') or 0):.2f}", labels.get("category", ""))

# --- stage timeline --------------------------------------------------------------
st.markdown("#### Trace")
for line in result.get("trace") or []:
    st.write(f"- `{line}`")

tab_labels, tab_sub, tab_final, tab_raw = st.tabs(
    ["🎯 Layer-1 labels (Laya)", "🧩 Sub-agent work order", "✍️ Main agent answer", "🧾 Raw"]
)

with tab_labels:
    c1, c2 = st.columns([1, 1])
    with c1:
        probs = labels.get("probabilities") or {}
        if probs:
            st.markdown("**Department probabilities (calibrated)**")
            frame = pd.DataFrame(
                {"probability": [float(v) for v in probs.values()]},
                index=[str(k) for k in probs.keys()],
            )
            st.bar_chart(frame)
    with c2:
        st.markdown("**Label payload**")
        st.json({k: v for k, v in labels.items() if k != "text"})

with tab_sub:
    if sub:
        s1, s2 = st.columns([1, 1])
        with s1:
            st.markdown(f"**{sub.get('dept_label', dept_label)}** · `{sub.get('model', '—')}`")
            st.write(sub.get("reasoning") or "")
            st.markdown("**Field instructions**")
            for step in sub.get("field_instructions") or []:
                st.write(f"- {step}")
            st.write(f"**Crew:** {sub.get('required_crew', '—')}")
            st.write(f"**Risk if delayed:** {sub.get('risk_if_delayed', '—')}")
        with s2:
            st.json(sub)
    else:
        st.warning("No sub-agent output (graph stopped after labelling).")

with tab_final:
    if final:
        st.success(f"**Citizen reply**\n\n{final.get('citizen_reply') or '—'}")
        f1, f2 = st.columns([1, 1])
        with f1:
            st.write(f"**Title:** {final.get('docket_title') or final.get('title') or '—'}")
            st.write(f"**Routing reason:** {final.get('routing_reason') or '—'}")
            st.write(f"**Dispatch brief:** {final.get('dispatch_brief') or '—'}")
            st.write(f"**Escalation:** {final.get('escalation_notes') or '—'}")
        with f2:
            st.json(final)
    else:
        st.warning("No final answer returned.")

with tab_raw:
    st.json({
        "route": result.get("route"),
        "mode": result.get("mode"),
        "elapsed_ms": result.get("elapsed_ms"),
        "labels": labels,
        "sub_agent": sub,
        "final": final,
        "flat": flat,
        "trace": result.get("trace"),
    })

# --- history ----------------------------------------------------------------------
history = st.session_state.get("history") or []
if history:
    st.markdown("#### Session history")
    st.dataframe(pd.DataFrame(history), width="stretch", hide_index=True)
