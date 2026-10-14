"""Run one ticket through the graph from the terminal.

    python -m agents.cli "Deep pothole near Metro Pillar 18, two-wheelers swerving"
    python -m agents.cli --file ticket.txt --json
"""
from __future__ import annotations

import argparse
import json
import sys

# Windows consoles default to cp1252, which cannot print the typographic characters
# the models emit (non-breaking hyphens, em dashes). Force UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # piped/redirected streams
        pass

from .graph import run_ticket


def main() -> int:
    p = argparse.ArgumentParser(description="UrbanFix: Laya-labelled main agent -> 4 sub-agents -> main answer")
    p.add_argument("text", nargs="?", help="Ticket text (or use --file)")
    p.add_argument("--file", help="Read the ticket from a file")
    p.add_argument("--json", action="store_true", help="Print raw JSON only")
    args = p.parse_args()

    if args.file:
        with open(args.file, encoding="utf-8") as f:
            text = f.read()
    else:
        text = args.text
    if not text or not text.strip():
        p.error("provide ticket text or --file")

    out = run_ticket(text.strip())
    if args.json:
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 0

    lab, sub, fin = out["labels"], out["sub_agent"], out["final"]
    print("=" * 72)
    print(f"ROUTED TO : {out['route']}  ({fin['dept_label']})")
    print(f"LAYER 1   : Laya {lab['source']} in {lab['label_ms']} ms | "
          f"conf {lab['department_confidence']:.2f} | {lab['priority']} | "
          f"urgent {lab['urgent_probability']:.2f}")
    print(f"PROBS     : {json.dumps(lab['probabilities'])}")
    print(f"SUB-AGENT : {sub.get('model')} -> {sub.get('defect_type')} | crew: {sub.get('required_crew')}")
    print(f"FINAL     : {fin['docket_title']}")
    print(f"            priority {fin['priority']} | SLA {fin['sla_hours']} h | confidence {fin['confidence']}")
    print(f"ROUTING   : {fin['routing_reason']}")
    print(f"DISPATCH  : {fin['dispatch_brief']}")
    print(f"ESCALATE  : {fin['escalation_notes']}")
    print(f"CITIZEN   : {fin['citizen_reply']}")
    print("-" * 72)
    for line in out["trace"]:
        print(f"  trace: {line}")
    print(f"  total {out['elapsed_ms']} ms")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
