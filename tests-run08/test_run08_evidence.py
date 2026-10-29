"""Consistency checks for run-08: figures quoted in
experiments/run-08-a-mem-baseline.md and README.md must match the raw
result JSONs, and the JSON totals must be internally consistent.

These checks catch transcription errors between the data and the write-up.
They do not independently verify the experiment: the JSONs were produced
by the author's own scripts from private session logs that are not
published.

Run: PYTHONPATH= VIRTUAL_ENV= .venv/Scripts/python.exe -m pytest tests/ -q
"""
import json
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "experiments", "run-08-data")
sys.path.insert(0, os.path.join(ROOT, "scripts"))



AMEM = json.load(open(os.path.join(DATA, "run08_amem_results.json"), encoding="utf-8"))
DB = json.load(open(os.path.join(DATA, "run08_dualbrain_results.json"), encoding="utf-8"))
DOC = open(
    os.path.join(ROOT, "experiments", "run-08-a-mem-baseline.md"),
    encoding="utf-8",
).read()
README = open(
    os.path.join(ROOT, "README.md"),
    encoding="utf-8",
).read()


# --- corpus shape ---
def test_corpus_sizes():
    assert AMEM["corpus_split"] == {"A": 8, "B": 4}
    assert len(AMEM["notes"]) == 12


def test_corpus_notes_wellformed():
    for note in AMEM["notes"]:
        assert isinstance(note["id"], str) and note["id"]


# --- A-MEM arm: raw internal consistency ---
def test_amem_totals_match_per_note_sums():
    n, notes = AMEM["total_write_tokens"], AMEM["notes"]
    assert n["calls"] == sum(x["llm_calls"] for x in notes)
    assert n["prompt"] == sum(x["prompt_tokens"] for x in notes)
    assert n["completion"] == sum(x["completion_tokens"] for x in notes)


def test_amem_committed_figures():
    n = AMEM["total_write_tokens"]
    assert n["calls"] == 11
    assert n["prompt"] == 9869
    assert n["completion"] == 3278
    assert len(AMEM["notes"]) == 12
    assert AMEM["corpus_split"] == {"A": 8, "B": 4}


def test_amem_first_note_free_steady_state_one_call():
    notes = AMEM["notes"]
    assert notes[0]["llm_calls"] == 0
    assert all(x["llm_calls"] == 1 for x in notes[1:])


def test_amem_per_note_figure():
    n = AMEM["total_write_tokens"]
    assert abs((n["prompt"] + n["completion"]) / 12 - 1095.6) < 0.1


def test_amem_corpus_b_cost_5611():
    b = [x for x in AMEM["notes"] if x["id"].startswith("op-")]
    assert len(b) == 4
    assert sum(x["prompt_tokens"] + x["completion_tokens"] for x in b) == 5611


def test_amem_probes_present():
    assert len(AMEM["probes"]) == 7
    assert all(len(p["results"]) == 3 for p in AMEM["probes"])


# --- dual-brain arm ---
def test_db_recall_5_of_7():
    hits = sum(1 for p in DB["probes"] if p["recall"])
    assert hits == 5
    assert DB["recall"] == "5/7"


def test_db_projects_and_read_costs():
    assert DB["projects_probed"] == 4
    per = DB["read_tokens_per_project"]
    assert per == {
        "software-auditor": 3049,
        "dual-brain-memory": 836,
        "Insectflux-dev": 1541,
        "emara-release": 590,
    }
    assert sum(per.values()) == DB["read_tokens_all_projects_approx"]


# --- the writeup must quote the verified figures, not stale ones ---
def test_doc_quotes_correct_corpus_b_cost():
    assert "5,611 tokens" in DOC
    assert "4,166" not in DOC
    assert "6,375" not in DOC


def test_doc_quotes_amem_totals():
    assert "9,869 p + 3,278 c" in DOC
    assert "11" in DOC  # LLM calls
    assert "1,095.6" in DOC  # per-note


def test_doc_states_honest_limitations():
    assert "analyze_content" in DOC
    assert "n=1 corpus" in DOC or "n = 1 corpus" in DOC


def test_readme_quotes_verified_run08_figures():
    assert "13,147" in README
    assert "11" in README
    assert "5/7" in README or "5 / 7" in README
    assert "7/7" in README or "7 / 7" in README

