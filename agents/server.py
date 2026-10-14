"""HTTP API for the agent graph.

    python -m uvicorn agents.server:app --port 8000

Endpoints
  GET  /api/health   service + model status
  POST /api/label    layer-1 only: local Laya labels the ticket (~2 s, no LLM)
  POST /api/triage   full graph: Laya labels -> main agent routes -> sub-agent -> main answer
"""
from __future__ import annotations

import threading
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import DEPARTMENTS, DEPARTMENT_KEYS, FREE_MODELS, GROQ_API_KEY, LAYA_DIR
from .graph import run_ticket
from .laya_labeler import get_laya_agent, label_ticket, multilingual_loaded

app = FastAPI(title="UrbanFix Agent API", version="1.0.0")

# Vite dev server runs on :3000 (see package.json).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TicketRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Raw citizen ticket text")
    meta: dict = Field(default_factory=dict, description="Optional location/ward/title context")


@app.on_event("startup")
def warm_laya() -> None:
    """Load the English checkpoint once at boot, then the multilingual one in the background
    so a Tamil/Hindi ticket does not pay the model-load cost on its first request."""
    get_laya_agent()

    def _warm_multi() -> None:
        try:
            get_laya_agent(multilingual=True)
        except Exception:
            pass  # multilingual stays optional; label_ticket falls back on its own

    threading.Thread(target=_warm_multi, daemon=True, name="warm-multilingual").start()


@app.get("/api/health")
def health() -> dict:
    agent = get_laya_agent()
    return {
        "ok": True,
        "laya": {
            "loaded": agent is not None,
            "multilingual": multilingual_loaded(),
            "dir": str(LAYA_DIR),
        },
        "groq_key_set": bool(GROQ_API_KEY),
        "free_models": FREE_MODELS,
        "departments": DEPARTMENT_KEYS,
        "graph": "main_agent -> [4 sub-agents] -> main_answer",
    }


@app.post("/api/label")
def label(req: TicketRequest) -> dict:
    """Main-agent layer-1 labelling only (local Laya, calibrated probabilities)."""
    try:
        return label_ticket(req.text).to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # checkpoint unusable -> surface, client keeps its fallback
        raise HTTPException(status_code=503, detail=f"Laya unavailable: {exc}")


@app.post("/api/triage")
def triage(req: TicketRequest) -> dict:
    """Full graph run: Laya label -> route to sub-agent -> main agent's final answer."""
    started = time.perf_counter()
    try:
        out = run_ticket(req.text, meta=req.meta)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")

    lab, sub, fin = out["labels"], out["sub_agent"] or {}, out["final"] or {}
    dept = fin.get("department_key") or out["route"]
    return {
        # flat fields for the React app
        "route": out["route"],
        "department": dept,
        "deptLabel": fin.get("dept_label") or lab["dept_label"],
        "category": fin.get("category") or lab["category"],
        "defectType": fin.get("defect_type") or "Public Hazard",
        "priority": fin.get("priority") or lab["priority"],
        "slaHours": fin.get("sla_hours") or lab["sla_hours"],
        "title": fin.get("docket_title"),
        "confidence": lab["department_confidence"],
        "labelSource": lab["source"],
        "routingReason": fin.get("routing_reason"),
        "dispatchBrief": fin.get("dispatch_brief"),
        "escalationNotes": fin.get("escalation_notes"),
        "citizenReply": fin.get("citizen_reply"),
        "requiredCrew": sub.get("required_crew"),
        "deptScope": DEPARTMENTS.get(dept, {}).get("category"),
        # full graph artefacts
        "labels": lab,
        "subAgent": sub,
        "final": fin,
        "trace": out["trace"],
        "elapsedMs": out["elapsed_ms"],
        "serverMs": int((time.perf_counter() - started) * 1000),
    }
