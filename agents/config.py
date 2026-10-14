"""Shared configuration for the UrbanFix agent graph (local Laya labeller + Groq sub-agents)."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# --- Groq (free-tier models only) -------------------------------------------------
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_BASE_URL = "https://api.groq.com"  # the SDK appends /openai/v1 itself

# Free models confirmed available on this key. Change freely - all are $0 on the free tier.
# qwen3.8-27b is free but measured ~50 s/completion on this key, so the graph defaults to the
# two gpt-oss models; keep `mid` here as a drop-in alternative if you want to swap one in.
FREE_MODELS = {
    "heavy": "openai/gpt-oss-120b",   # strongest reasoning
    "mid": "qwen/qwen3.8-27b",        # available, but slow on the free tier
    "fast": "openai/gpt-oss-20b",     # lowest latency
}

# --- Mistral (second free provider - used when Groq rate-limits) --------------------
# `mistral-small-latest` / `mistral-medium-latest` 429 on this key; these two respond.
MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY", "")
MISTRAL_BASE_URL = "https://api.mistral.ai/v1"
MISTRAL_MODEL = os.getenv("MISTRAL_MODEL", "ministral-8b-latest")

# --- Local Laya checkpoint --------------------------------------------------------
# The weights are already vendored in ./laya (model.safetensors + tokenizer + encoder),
# so inference is fully offline - no HuggingFace download happens.
LAYA_DIR = Path(os.getenv("LAYA_DIR", str(ROOT / "laya")))
if not LAYA_DIR.is_absolute():
    LAYA_DIR = (ROOT / LAYA_DIR).resolve()
LAYA_DEVICE = os.getenv("LAYA_DEVICE", "cpu")

# --- Departments the app already uses (src/types.ts) ------------------------------
# key = routing label used by Laya as the choice option
DEPARTMENTS: dict[str, dict] = {
    "highways": {
        "dept_label": "GCC Works / Highways",
        "category": "Roads & Potholes",
        "base_sla_hours": 4,
        "crew": "GCC Asphalt Repair Crew",
        "model": FREE_MODELS["heavy"],
        "scope": (
            "Road surface defects: potholes, asphalt craters, rutting, cracked or sunken "
            "carriageway, damaged footpaths/covers, broken kerbstones, faded lane markings, "
            "damaged crash barriers, road cave-ins and encroachment on the carriageway."
        ),
        "system": (
            "You are the HIGHWAYS sub-agent of UrbanFix, an AI triage system for the Greater "
            "Chennai Corporation (GCC) Works / Highways department. You receive a citizen ticket "
            "that has already been labelled by a calibrated local classifier. Decide the defect "
            "type, work order and dispatch plan for a road-surface problem. Be concrete: name the "
            "repair method (e.g. cut-and-fill patch, cold mix, full-depth reclaim), the crew, the "
            "traffic-management step, and the SLA. Always answer in the requested JSON schema."
        ),
    },
    "electric": {
        "dept_label": "TANGEDCO / Electrical Works",
        "category": "Electricity & Grid",
        "base_sla_hours": 2,
        "crew": "TANGEDCO Lineman Rapid Van",
        "model": FREE_MODELS["heavy"],
        "scope": (
            "Electrical hazards: sparking or flickering streetlights, dead luminaires, exposed or "
            "sagging HT/LT cables, damaged distribution transformers, energised downed poles, "
            "shock risk, earthing failures, meter box damage."
        ),
        "system": (
            "You are the ELECTRICAL sub-agent of UrbanFix, an AI triage system for TANGEDCO / "
            "Electrical Works. You receive a citizen ticket already labelled by a calibrated local "
            "classifier. Treat every live-electric report as a potential life-safety incident: state "
            "the isolation/de-energising step first, then the repair, the crew and the SLA. Always "
            "answer in the requested JSON schema."
        ),
    },
    "hydro": {
        "dept_label": "CMWSSB / Water & Sewerage",
        "category": "Water & Drainage",
        "base_sla_hours": 6,
        "crew": "CMWSSB Pipe & Sewerage Unit",
        "model": FREE_MODELS["fast"],
        "scope": (
            "Water and drainage: potable-water pipe leaks or bursts, valve and coupling failure, "
            "sewage overflow, blocked storm drains, clogged manholes, chronic waterlogging, "
            "contamination, low pressure, illegal connection damage."
        ),
        "system": (
            "You are the HYDRO sub-agent of UrbanFix, an AI triage system for CMWSSB / Water & "
            "Sewerage. You receive a citizen ticket already labelled by a calibrated local "
            "classifier. Prioritise contamination and waterlogging public-health risk, then the "
            "hydraulic repair plan, crew and SLA. Always answer in the requested JSON schema."
        ),
    },
    "sanitation": {
        "dept_label": "Zonal Solid Waste Management",
        "category": "Sanitation & Waste",
        "base_sla_hours": 8,
        "crew": "Zonal Sanitation Squad",
        "model": FREE_MODELS["fast"],
        "scope": (
            "Sanitation: overflowing bins or dumpsters, uncollected garbage, dumped construction "
            "debris, dead animals, stagnant waste attracting vectors, street sweeping failures, "
            "public toilet blockage, mosquito breeding."
        ),
        "system": (
            "You are the SANITATION sub-agent of UrbanFix, an AI triage system for the Zonal Solid "
            "Waste Management department. You receive a citizen ticket already labelled by a "
            "calibrated local classifier. Cover public-health risk, the clearance/deposal plan, the "
            "crew, the frequency fix needed so it does not recur, and the SLA. Always answer in the "
            "requested JSON schema."
        ),
    },
}

DEPARTMENT_KEYS = list(DEPARTMENTS.keys())

# Priority -> SLA multiplier applied to the department's base SLA.
PRIORITY_SLA_MULTIPLIER = {"P1": 1, "P2": 2, "P3": 4}


def sla_for(dept: str, priority: str) -> int:
    base = DEPARTMENTS[dept]["base_sla_hours"]
    return int(base * PRIORITY_SLA_MULTIPLIER.get(priority, 2))
