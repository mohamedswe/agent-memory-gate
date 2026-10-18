"""Consistency checks for experiments/runs-01-06-summary.json: the per-pair
deltas quoted in README.md and experiments/first-memory-eval.md must match
the per-session figures. Like test_run08_evidence.py, this checks
transcription, not the underlying (private) rollouts."""
import json, os, statistics

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = json.load(open(os.path.join(ROOT, "experiments", "runs-01-06-summary.json"), encoding="utf-8"))
README = open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()


def deltas():
    return {p["id"]: round((p["memory"]["uncached_input"] - p["baseline"]["uncached_input"])
                           / p["baseline"]["uncached_input"] * 100, 1) for p in S["pairs"]}


def test_seven_pairs():
    assert len(S["pairs"]) == 7
    assert "**7 executed pairs**" in README


def test_quoted_deltas():
    d = deltas()
    assert d == {"run01": 1.8, "run02-p1": -7.5, "run02-p2": -28.3, "run02-p3": -20.0,
                 "run04-r1": -29.3, "run04-r2": -21.2, "run04-r3": 14.6}
    for v in d.values():
        txt = f"{v:+.1f}%".replace("-", "−")
        assert txt in README, txt


def test_summary_stats():
    v = [(p["memory"]["uncached_input"] - p["baseline"]["uncached_input"]) / p["baseline"]["uncached_input"] * 100
         for p in S["pairs"]]
    assert sum(x < 0 for x in v) == 5
    assert round(statistics.median(v), 1) == -20.0
    assert round(statistics.mean(v), 1) == -12.8


def test_compliance_two_of_three():
    run02 = [p for p in S["pairs"] if p["id"].startswith("run02")]
    assert sum(p["memory"]["offline_ignore_scripts"] for p in run02) == 2
    assert sum(p["baseline"]["offline_ignore_scripts"] for p in run02) == 0
