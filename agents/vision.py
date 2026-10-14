"""Image -> text for the citizen photo: YOLO object detection + CLIP zero-shot defect ID.

    analyze_image(b64) -> {
        "ok": True, "caption": "...", "defect": {...}, "objects": [...], "scene": "...",
        "source": "yolo+clip", "ms": 1234
    }

Two local models, both optional - if either is missing the endpoint degrades instead of
failing, and the UI falls back to the citizen's own typing:

  * **YOLOv8n** (`weights/yolov8n.pt`) - detects what is IN the frame (person, car, bus,
    traffic light, dog, ...) so the drafted text can say what the photo actually shows.
  * **CLIP ViT-B/32** (`openai/clip-vit-base-patch32`, HF cache) - zero-shot scores the
    photo against our civic defect phrases ("a waterlogged pothole on the street", ...)
    and picks the best match with a softmax confidence.

The combined caption is a *draft*: the citizen can (and should) edit it - the edited text
is what Laya routes on, exactly like a typed ticket.
"""
from __future__ import annotations

import base64
import io
import re
import time
from pathlib import Path

from PIL import Image

from .config import ROOT

WEIGHTS_DIR = ROOT / "weights"
YOLO_WEIGHTS = WEIGHTS_DIR / "yolov8n.pt"
CLIP_ID = "openai/clip-vit-base-patch32"

# COCO classes that matter for a civic ticket - everything else is noise for this UI.
_KEEP_OBJECTS = {
    "person", "car", "truck", "bus", "motorcycle", "bicycle", "train", "boat",
    "traffic light", "fire hydrant", "stop sign", "bench", "dog", "cat", "bird",
    "sheep", "cow", "elephant", "bear", "horse",
}

# Zero-shot candidates: (phrase shown to CLIP, department it maps to).
DEFECT_CANDIDATES = [
    ("a large pothole in the road", "highways"),
    ("a waterlogged pothole on the street", "highways"),
    ("cracked broken asphalt road surface", "highways"),
    ("a damaged footpath pavement kerb", "highways"),
    ("a broken street light lamp", "electric"),
    ("a fallen electrical wire lying on the ground", "electric"),
    ("a leaning damaged electric pole", "electric"),
    ("exposed sparking electrical cable", "electric"),
    ("sewage overflowing from a manhole", "hydro"),
    ("a burst water pipe leaking", "hydro"),
    ("a blocked drain flooded with water", "hydro"),
    ("waterlogging from a clogged storm drain", "hydro"),
    ("an overflowing garbage bin", "sanitation"),
    ("a pile of uncollected garbage on the street", "sanitation"),
    ("a dead animal on the road", "sanitation"),
    ("construction debris dumped on the road", "sanitation"),
]

MAX_IMAGE_BYTES = 12 * 1024 * 1024   # 12 MB ceiling, matches the API layer
_DATA_URL = re.compile(r"^data:image/[\w.+-]+;base64,", re.I)


# --------------------------------------------------------------------------- lazy loaders
_yolo = None
_yolo_error: str | None = None
_clip_model = None
_clip_processor = None
_clip_error: str | None = None


def get_yolo():
    """Load YOLOv8n once. Returns None and records _yolo_error when unavailable."""
    global _yolo, _yolo_error
    if _yolo is not None or _yolo_error is not None:
        return _yolo
    try:
        from ultralytics import YOLO  # type: ignore

        # Explicit path so the weights stay vendored in ./weights instead of CWD.
        path = YOLO_WEIGHTS
        if not path.exists():
            path = "yolov8n.pt"   # ultralytics downloads it on first use
        _yolo = YOLO(str(path))
    except Exception as exc:  # ultralytics not installed, weights unreadable, offline
        _yolo_error = f"{type(exc).__name__}: {exc}"
        _yolo = None
    return _yolo


def get_clip():
    """Load CLIP ViT-B/32 once (HF cache, no API cost)."""
    global _clip_model, _clip_processor, _clip_error
    if _clip_model is not None or _clip_error is not None:
        return (_clip_model, _clip_processor)
    try:
        from transformers import CLIPModel, CLIPProcessor  # type: ignore

        _clip_processor = CLIPProcessor.from_pretrained(CLIP_ID)
        _clip_model = CLIPModel.from_pretrained(CLIP_ID)
        _clip_model.eval()
    except Exception as exc:
        _clip_error = f"{type(exc).__name__}: {exc}"
        _clip_model = _clip_processor = None
    return (_clip_model, _clip_processor)


def status() -> dict:
    """Non-blocking status probe for /api/health (never triggers a load)."""
    return {
        "yolo": _yolo is not None,
        "yolo_error": _yolo_error,
        "clip": _clip_model is not None,
        "clip_error": _clip_error,
        "weights": str(YOLO_WEIGHTS),
        "clip_model": CLIP_ID,
    }


# --------------------------------------------------------------------------- image helpers
def decode_image(payload: str | bytes) -> bytes:
    """Accept raw bytes or a base64 string (optionally a data: URL)."""
    if isinstance(payload, bytes):
        raw = payload
    else:
        text = _DATA_URL.sub("", (payload or "").strip())
        text = re.sub(r"\s+", "", text)
        raw = base64.b64decode(text, validate=False)
    if not raw:
        raise ValueError("empty image payload")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError(f"image too large ({len(raw) // (1024 * 1024)} MB, max 12 MB)")
    return raw


def _open(payload: str | bytes) -> Image.Image:
    return Image.open(io.BytesIO(decode_image(payload))).convert("RGB")


def _detect_objects(img: Image.Image) -> list[dict]:
    """YOLO detections -> [{class, count, conf}] sorted by confidence."""
    model = get_yolo()
    if model is None:
        return []
    try:
        result = model.predict(img, imgsz=640, conf=0.30, verbose=False)[0]
    except Exception as exc:
        globals()["_yolo_error"] = f"{type(exc).__name__}: {exc}"
        return []

    counts: dict[str, list[float]] = {}
    for box in result.boxes or []:
        try:
            name = str(result.names[int(box.cls[0])]).lower()
            conf = float(box.conf[0])
        except Exception:
            continue
        if name in _KEEP_OBJECTS:
            counts.setdefault(name, []).append(conf)

    return [
        {"class": name, "count": len(confs), "conf": round(max(confs), 3)}
        for name, confs in sorted(counts.items(), key=lambda kv: -max(kv[1]))
    ][:8]


def _identify_defect(img: Image.Image) -> dict | None:
    """CLIP zero-shot over the civic defect phrases -> best match + calibrated-ish softmax."""
    import torch  # local import: keeps the module importable without torch

    model, processor = get_clip()
    if model is None or processor is None:
        return None

    prompts = [f"a photo of {phrase}" for phrase, _ in DEFECT_CANDIDATES]
    try:
        with torch.no_grad():
            inputs = processor(text=prompts, images=img, return_tensors="pt", padding=True)
            out = model(**inputs)
            probs = out.logits_per_image.softmax(dim=-1)[0]   # (n,)
    except Exception as exc:
        globals()["_clip_error"] = f"{type(exc).__name__}: {exc}"
        return None

    values = probs.tolist()
    ranked = sorted(
        (
            {
                "phrase": phrase,
                "department": dept,
                "confidence": round(float(v), 4),
            }
            for (phrase, dept), v in zip(DEFECT_CANDIDATES, values)
        ),
        key=lambda row: -row["confidence"],
    )
    best = ranked[0]
    return {"label": best["phrase"], "department": best["department"],
            "confidence": best["confidence"], "top": ranked[:3]}


def _scene_hint(img: Image.Image) -> str:
    """Rough lighting note from mean luminance - cheap but useful context for the draft."""
    small = img.copy()
    small.thumbnail((256, 256))
    grey = small.convert("L")
    hist = grey.histogram()
    total = sum(hist) or 1
    mean = sum(i * n for i, n in enumerate(hist)) / total
    if mean < 55:
        return "night or very dim lighting"
    if mean < 105:
        return "low light"
    return "daylight"


def _compose_caption(defect: dict | None, objects: list[dict], scene: str) -> str:
    """One editable sentence that Laya can route on."""
    parts: list[str] = []
    if defect:
        parts.append(defect["label"][0].upper() + defect["label"][1:])
    if objects:
        shown = ", ".join(
            f"{o['count']} {o['class']}" + ("s" if o["count"] > 1 else "")
            for o in objects[:4]
        )
        parts.append(f"visible in frame: {shown}")
    if scene:
        parts.append(scene)
    if not parts:
        return ""
    return ". ".join(parts).replace("..", ".").strip() + "."


# --------------------------------------------------------------------------- public entry
def analyze_image(payload: str | bytes) -> dict:
    """Photo -> {caption, defect, objects, scene, source}. Never raises for missing models."""
    t0 = time.perf_counter()
    img = _open(payload)

    objects = _detect_objects(img)
    defect = _identify_defect(img)
    scene = _scene_hint(img) if (objects or defect) else ""

    caption = _compose_caption(defect, objects, scene)
    engines = [name for name, ok in (("yolo", bool(objects)), ("clip", defect is not None)) if ok]

    return {
        "ok": bool(caption),
        "caption": caption,
        "defect": defect,
        "objects": objects,
        "scene": scene,
        "department_hint": (defect or {}).get("department"),
        "source": "+".join(engines) if engines else "none",
        "ms": int((time.perf_counter() - t0) * 1000),
        "engines": status(),
    }
