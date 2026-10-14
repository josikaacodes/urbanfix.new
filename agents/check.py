"""Smoke test: one ticket per department through the full graph.

    python -m agents.check
"""
from __future__ import annotations

import sys

from .graph import run_ticket

CASES = [
    ("sanitation", "Heavy garbage bin overflow blocking the footpath at Market West Gate, foul smell and dogs scattering waste"),
    ("hydro", "Underground potable water pipe coupling ruptured, clean drinking water flooding the pavement and eroding the road"),
    ("highways", "Deep asphalt crater expanding on the bus lane near Metro Pillar 18, two-wheelers swerving into oncoming traffic"),
    ("electric", "Streetlight luminaire sparking above the school crosswalk, the crossing is pitch dark at night"),
]


def main() -> int:
    failures = []
    for expected, text in CASES:
        out = run_ticket(text)
        lab, sub, fin = out["labels"], out["sub_agent"], out["final"]
        got = out["route"]
        ok = got == expected
        if not ok:
            failures.append((expected, got))
        print(f"[{'OK ' if ok else 'FAIL'}] {expected:>11} -> {got:>11} | "
              f"conf {lab['department_confidence']:.2f} ({lab['source']}) | "
              f"{fin['priority']} {fin['sla_hours']}h | {sub['model']} | {out['elapsed_ms']} ms")
        print(f"        {fin['docket_title']}")
        print(f"        citizen: {fin['citizen_reply'][:110]}")
        for line in out["trace"]:
            print(f"        trace: {line}")
    if failures:
        print(f"\n{len(failures)} routing failure(s): {failures}")
        return 1
    print("\nall 4 routes OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
