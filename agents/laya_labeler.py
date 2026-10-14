"""Local Laya labeller - the main agent's labelling step.

Runs the vendored Laya RL-Agent checkpoint in ./laya entirely offline (no HF download) and
returns calibrated probabilities for:
  * department   -> which of the 4 sub-agents the ticket is routed to
  * severity     -> P1 / P2 / P3
  * urgent       -> immediate danger to life (noul = P(no-uncertainty-of-life) style binary)

If torch/transformers or the checkpoint cannot be loaded, a deterministic keyword
labeller is used so the graph never breaks.
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path

from .config import DEPARTMENTS, DEPARTMENT_KEYS, LAYA_DIR, LAYA_DEVICE, ROOT

# Option text shown to Laya for each department choice (keys are the labels we route on).
DEPARTMENT_CRITERIA = {
    "highways": "Road surface, potholes, asphalt, footpath, kerb, lane marking, cave-in, road works",
    "electric": "Street light, lamp, cable, transformer, sparking, shock, power outage, TANGEDCO",
    "hydro": "Water pipe, leakage, burst, sewage, drain, manhole, waterlogging, gutter, CMWSSB",
    "sanitation": "Garbage, waste bin, overflowing dump, dead animal, sweeping, mosquito, debris",
}

SEVERITY_LEVELS = [
    "P3 routine: nuisance only, no safety risk, can wait for the next scheduled sweep",
    "P2 moderate: degraded service or a developing hazard, localised impact",
    "P1 critical: immediate danger to life, traffic, or health; needs emergency dispatch",
]

URGENT_CRITERIA = {
    "false": "no immediate danger to life",
    "true": "yes, people could be hurt right now",
}


@dataclass
class Labels:
    """Everything the main agent extracts from the raw ticket before routing."""

    text: str
    department: str
    dept_label: str
    category: str
    department_confidence: float
    probabilities: dict[str, float]
    severity_score: float
    priority: str
    sla_hours: int
    urgent_probability: float
    label_ms: int
    source: str  # "laya" | "keyword-fallback"

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------- questions
def build_questions() -> dict:
    return {
        "department": {
            "type": "choice",
            "instructions": (
                "Route this civic complaint ticket to exactly one municipal department. "
                "Reply with the department whose scope covers the reported defect."
            ),
            "criteria": dict(DEPARTMENT_CRITERIA),
        },
        "severity": {
            "type": "score",
            "instructions": "Rate how urgent this ticket is for the municipal dispatch queue.",
            "criteria": list(SEVERITY_LEVELS),
        },
        "urgent": {
            "type": "noul",
            "instructions": "Does this ticket describe an immediate danger to life or safety?",
            "criteria": dict(URGENT_CRITERIA),
        },
    }


# --------------------------------------------------------------------------- inference
_agent = None
_agent_error: str | None = None


def get_laya_agent():
    """Load the vendored checkpoint once (offline). Returns None + sets _agent_error on failure."""
    global _agent, _agent_error
    if _agent is not None or _agent_error is not None:
        return _agent

    try:
        if not LAYA_DIR.exists():
            raise FileNotFoundError(f"Laya directory not found: {LAYA_DIR}")
        # rl_agent_api.py imports rl_common.py by bare module name.
        laya_path = str(LAYA_DIR)
        if laya_path not in sys.path:
            sys.path.insert(0, laya_path)

        from rl_agent_api import RLAgent  # type: ignore

        _agent = RLAgent(model_dir=laya_path, device=LAYA_DEVICE)
    except Exception as exc:  # torch/transformers missing, bad weights, etc.
        _agent_error = f"{type(exc).__name__}: {exc}"
        _agent = None
    return _agent


# -------------------------------------------------------------------- keyword fallback
_KEYWORDS = {
    "electric": ["light", "lamp", "luminaire", "spark", "wire", "cable", "shock", "electr",
                 "transformer", "pole", "outage", "current", "bulb", "flicker"],
    "hydro": ["water", "pipe", "leak", "drain", "sewage", "manhole", "flood", "waterlog",
              "valve", "gutter", "sewer", "tap", "pressure", "stagnant"],
    "sanitation": ["garbage", "waste", "bin", "dump", "trash", "sweep", "dead animal", "debris",
                   "smell", "odour", "odor", "mosquito", "litter", "rubbish"],
    "highways": ["pothole", "road", "asphalt", "footpath", "pavement", "kerb", "kerb", "crater",
                 "lane", "tar", "sinkhole", "sidewalk", "marking"],
}


def keyword_label(text: str) -> Labels:
    low = text.lower()
    scores = {k: sum(low.count(kw) for kw in kws) for k, kws in _KEYWORDS.items()}
    total = sum(scores.values()) or 1
    dept = max(scores, key=scores.get) if any(scores.values()) else "highways"
    probs = {k: round(v / total, 4) for k, v in scores.items()}
    if not any(scores.values()):
        probs = {k: round(1 / len(DEPARTMENT_KEYS), 4) for k in DEPARTMENT_KEYS}
    urgent = 1.0 if any(w in low for w in ["danger", "injur", "accident", "shock", "fire",
                                           "collapse", "electrocut", "gas"]) else 0.15
    sev = 2 if urgent > 0.5 else (1 if total >= 2 else 0)
    priority = ["P3", "P2", "P1"][sev]
    return _assemble(text, dept, probs, float(sev), priority, urgent, 0, "keyword-fallback")


def _assemble(text, dept, probs, sev, priority, urgent, ms, source) -> Labels:
    from .config import sla_for

    meta = DEPARTMENTS[dept]
    return Labels(
        text=text,
        department=dept,
        dept_label=meta["dept_label"],
        category=meta["category"],
        department_confidence=float(probs.get(dept, 0.0)),
        probabilities=probs,
        severity_score=sev,
        priority=priority,
        sla_hours=sla_for(dept, priority),
        urgent_probability=round(float(urgent), 4),
        label_ms=ms,
        source=source,
    )


def label_ticket(text: str) -> Labels:
    """Main-agent labelling step. Laya first, keyword fallback if the checkpoint is unusable."""
    text = (text or "").strip()
    if not text:
        raise ValueError("Empty ticket text - nothing to label.")

    agent = get_laya_agent()
    if agent is None:
        return keyword_label(text)

    try:
        t0 = time.perf_counter()
        out = agent.system_one(text, build_questions())
        ms = int((time.perf_counter() - t0) * 1000)

        ans = out["answers"]
        dept = ans["department"]["choice"]
        if dept not in DEPARTMENTS:
            dept = max(ans["department"]["probabilities"], key=ans["department"]["probabilities"].get)
            if dept not in DEPARTMENTS:
                dept = "highways"

        probs = {k: float(v) for k, v in ans["department"]["probabilities"].items() if k in DEPARTMENTS}
        norm = sum(probs.values()) or 1.0
        probs = {k: round(v / norm, 4) for k, v in probs.items()}

        sev = float(ans["severity"]["score"])          # 0..2 -> P3..P1
        priority = ["P3", "P2", "P1"][max(0, min(2, int(round(sev))))]
        urgent = float(ans["urgent"]["noul"])

        # A confident life-safety signal escalates even if the severity head said P2.
        if urgent >= 0.7 and priority != "P1":
            priority = "P1"

        return _assemble(text, dept, probs, sev, priority, urgent, ms, "laya")
    except Exception:
        # Keep the pipeline alive: Laya is a label source, never a single point of failure.
        return keyword_label(text)


if __name__ == "__main__":  # quick manual check
    print(json.dumps(label_ticket(sys.argv[1] if len(sys.argv) > 1 else "Deep pothole on the road").to_dict(), indent=2))
