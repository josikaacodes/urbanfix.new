"""HTTP API for the agent graph.

    python -m uvicorn agents.server:app --port 8000

Endpoints
  GET  /api/health   service + model status
  POST /api/label    layer-1 only: local Laya labels the ticket (~2 s, no LLM)
  POST /api/triage   full graph: Laya labels -> main agent routes -> sub-agent -> main answer
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import DEPARTMENTS, DEPARTMENT_KEYS, FREE_MODELS, GROQ_API_KEY, LAYA_DIR
from .graph import run_ticket
from .laya_labeler import get_laya_agent, label_ticket, multilingual_loaded
from .vision import analyze_image, decode_image
from .vision import status as vision_status

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
        "vision": vision_status(),
        "tickets_stored": len(_load_tickets()),
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


# ==================================================================== vision (photo -> text)
class VisionRequest(BaseModel):
    image: str = Field(..., min_length=20, description="base64 image, data-URL or raw base64")


@app.post("/api/vision")
def vision(req: VisionRequest) -> dict:
    """Photo -> YOLO objects + CLIP zero-shot defect + an editable draft sentence.

    The draft is a *suggestion*: the citizen edits it, and the edited text is what Laya
    routes on. Missing models degrade to ok=False instead of 500-ing the demo.
    """
    try:
        return analyze_image(req.image)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"vision failed: {type(exc).__name__}: {exc}")


# ============================================================ server-side ticket handoff
# Tickets filed through the GovDesk UI live here so the officer panel (any browser, any
# device) really receives what the citizen sent - including the photo, stored on disk.
STORAGE_DIR = Path(__file__).resolve().parent / "storage"
PHOTOS_DIR = STORAGE_DIR / "photos"
TICKETS_FILE = STORAGE_DIR / "tickets.json"
MAX_TICKETS = 200
_LOCK = threading.Lock()


def _load_tickets() -> list[dict]:
    try:
        data = json.loads(TICKETS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_tickets(tickets: list[dict]) -> None:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    TICKETS_FILE.write_text(json.dumps(tickets, ensure_ascii=False, indent=1), encoding="utf-8")


def _safe_id(ticket_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "", ticket_id or "")[:40]


class TicketIn(BaseModel):
    id: str = Field(..., min_length=2, max_length=40)
    area: str = ""
    dept: str = ""
    desc: str = Field("", max_length=4000)
    priority: str = "P2"
    slaHours: int | None = None
    defect: str | None = None
    brief: str | None = None
    crew: str | None = None
    reply: str | None = None
    confidence: str | None = None
    source: str | None = None
    status: str = "Pending Dispatch"
    time: str = "Just now"
    photo: str | None = Field(None, description="base64 / data-URL image (saved to disk, not to JSON)")


class TicketPatch(BaseModel):
    status: str | None = None
    time: str | None = None


@app.post("/api/tickets")
def create_ticket(req: TicketIn) -> dict:
    """Store a filed ticket (+ its photo) so the officer panel can receive it."""
    record = req.model_dump(exclude={"photo"})
    record["photo_url"] = None

    tid = _safe_id(req.id)
    if req.photo:
        try:
            raw = decode_image(req.photo)
            match = re.match(r"^data:image/([\w.+-]+)", req.photo.strip(), re.I)
            suffix = "." + (match.group(1).lower() if match else "jpg").replace("jpeg", "jpg")
            PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
            (PHOTOS_DIR / f"{tid}{suffix}").write_bytes(raw)
            record["id"] = tid or record["id"]
            record["photo_url"] = f"/api/tickets/{record['id']}/photo"
        except Exception:
            record["photo_url"] = None   # ticket still files without the picture

    with _LOCK:
        tickets = [t for t in _load_tickets() if t.get("id") != record["id"]]
        tickets.insert(0, record)
        _save_tickets(tickets[:MAX_TICKETS])

    return {"ok": True, "ticket": record, "photo_saved": bool(record["photo_url"])}


@app.get("/api/tickets")
def list_tickets(area: str | None = None) -> dict:
    """Newest first; ?area= filters to one officer's zone."""
    with _LOCK:
        tickets = _load_tickets()
    if area:
        tickets = [t for t in tickets if t.get("area") == area]
    return {"ok": True, "count": len(tickets), "tickets": tickets}


@app.get("/api/tickets/{ticket_id}/photo")
def ticket_photo(ticket_id: str) -> Response:
    """The picture the citizen filed - this is what the officer actually receives."""
    base = _safe_id(ticket_id)
    for path in sorted(PHOTOS_DIR.glob(base + ".*")):
        suffix = path.suffix.lower()
        media = "image/jpeg" if suffix in (".jpg", ".jpeg") else f"image/{suffix.lstrip('.')}"
        return Response(
            content=path.read_bytes(),
            media_type=media,
            headers={"Cache-Control": "public, max-age=3600"},
        )
    raise HTTPException(status_code=404, detail="no photo stored for this ticket")


@app.patch("/api/tickets/{ticket_id}")
def update_ticket(ticket_id: str, req: TicketPatch) -> dict:
    """Officer actions (dispatch / resolve) sync back to the stored ticket."""
    with _LOCK:
        tickets = _load_tickets()
        for ticket in tickets:
            if ticket.get("id") == _safe_id(ticket_id):
                if req.status:
                    ticket["status"] = req.status
                if req.time:
                    ticket["time"] = req.time
                _save_tickets(tickets)
                return {"ok": True, "ticket": ticket}
    raise HTTPException(status_code=404, detail="ticket not found")


@app.delete("/api/tickets")
def clear_tickets() -> dict:
    """Demo reset: wipe stored tickets and their photos."""
    with _LOCK:
        _save_tickets([])
        if PHOTOS_DIR.exists():
            for path in PHOTOS_DIR.glob("*"):
                path.unlink(missing_ok=True)
    return {"ok": True, "cleared": True}
