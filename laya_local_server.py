"""Serve the locally-cloned convaiinnovations/laya checkpoints over HTTP.

Uses laya's own Jev-compatible FastAPI app (POST /v1/systemone) but injects a Router
pointed at the local `laya/` checkout, so no checkpoint is ever re-downloaded from the Hub.

    python laya_local_server.py          # http://127.0.0.1:8000
"""
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent / "laya"

# transformers probes for TensorFlow at import; TF's abseil runtime can deadlock model
# construction. Cheap insurance even when TF is absent.
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("LAYA_HOST", "127.0.0.1")
os.environ.setdefault("LAYA_PORT", "8000")
# Layas Router.__init__ takes `preload` as a boolean and always preloads every checkpoint
# when truthy, so all three (english, multilingual, typed-decisions) become resident -- which
# is what we want: a cold build costs seconds per switch on CPU, routing itself is microseconds.
os.environ.setdefault("LAYA_LOG_LEVEL", "info")

CHECKPOINTS = {
    "english": str(ROOT),
    "multilingual": str(ROOT / "multilingual"),
    "typed-decisions": str(ROOT / "typed-decisions"),
}


def main() -> None:
    for name, path in CHECKPOINTS.items():
        cfg = pathlib.Path(path) / "rl_agent_config.json"
        weights = pathlib.Path(path) / "model.safetensors"
        if not cfg.is_file() or not weights.is_file():
            sys.exit(f"missing local checkpoint for {name!r}: {path}")

    import uvicorn
    from laya import Router
    from laya.serve import create_app

    router = Router(models=CHECKPOINTS, preload=True)
    app = create_app(router)

    print(f"laya local server -> http://{os.environ['LAYA_HOST']}:{os.environ['LAYA_PORT']}")
    print(f"checkpoints: {CHECKPOINTS}")
    uvicorn.run(
        app,
        host=os.environ["LAYA_HOST"],
        port=int(os.environ["LAYA_PORT"]),
        log_level=os.environ.get("LAYA_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
