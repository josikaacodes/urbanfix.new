"""Smoke-test the local laya server: health, English, routed multilingual, and shapes."""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8000"

QUESTIONS = {
    "department": {
        "type": "choice",
        "instructions": "Which department should handle this request?",
        "criteria": {
            "billing": "invoices, payments, refunds",
            "technical": "bugs, outages, system errors",
            "sales": "pricing, new contracts",
            "other": "everything else",
        },
    },
    "urgency": {
        "type": "score",
        "instructions": "How urgent is this request?",
        "criteria": ["not urgent", "soon", "critical deadline or blocking issue"],
    },
    "churn_risk": {
        "type": "noul",
        "instructions": "Does the user threaten to cancel or leave?",
    },
}

CASES = [
    (
        "ENGLISH -> english checkpoint",
        {
            "from": "user@acme.com",
            "subject": "Duplicate charge on invoice #4411",
            "body": "Hi, we were billed twice for March. Please refund the duplicate today "
                    "or we will cancel our plan.",
        },
    ),
    (
        "TAMIL -> multilingual checkpoint",
        {"body": "மார்ச் மாதத்திற்கு இருமுறை கட்டணம் வசூலிக்கப்பட்டது, "
                 "தயவுசெய்து டூப்ளிகேட் தொகையை திரும்ப வழங்குங்கள்."},
    ),
    (
        "HINDI -> multilingual checkpoint",
        {"body": "मुझसे मार्च में दो बार शुल्क लिया गया, कृपया डुप्लिकेट राशि वापस करें।"},
    ),
]


def post(path: str, payload: dict) -> tuple[dict, float, int]:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            body = json.loads(r.read().decode())
            return body, (time.perf_counter() - t0) * 1000, r.status
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode()[:500]}, (time.perf_counter() - t0) * 1000, e.code


def main() -> int:
    # 1. wait for readiness
    for i in range(120):
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=5) as r:
                health = json.loads(r.read().decode())
                print(f"[health] {health}  (ready after ~{i}s)")
                break
        except Exception:
            time.sleep(1)
    else:
        print("[health] server never became ready")
        return 1

    # 2. inference cases
    for label, state in CASES:
        body, ms, status = post("/v1/systemone", {"state": state, "questions": QUESTIONS})
        if status != 200:
            print(f"\n{label}\n  HTTP {status}: {body}")
            continue
        a = body["answers"]
        print(f"\n{label}")
        print(f"  HTTP {status} | wall {ms:7.1f} ms | server inference {body.get('usage', {})}")
        print(f"  routing : {body['routing']['model']}  ({body['routing']['reason']})")
        print(f"  dept    : {a['department']['choice']}  probs={a['department']['probabilities']}")
        print(f"  urgency : {a['urgency']['score']}  probs={a['urgency']['probabilities']}")
        print(f"  churn   : {a['churn_risk']['noul']}  conf={a['churn_risk']['confidence']}")

    # 3. error handling probe (bad question should be 422, not a crash)
    body, ms, status = post("/v1/systemone", {"state": "x", "questions": {"bad": {"type": "nope"}}})
    print(f"\n[validation] malformed question -> HTTP {status}: {body.get('detail', body)}")

    body, ms, status = post("/v1/systemone", {"questions": {}})
    print(f"[validation] missing state      -> HTTP {status}: {body.get('detail', body)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
