"""Tests for SARIF 2.1.0 export, CLI --sarif-out, and GitHub Marketplace action.yml."""

from __future__ import annotations

import json
from pathlib import Path

from mcp_guard.cli import main as cli_main
from mcp_guard.runner import render_sarif_report, run_builtin_chaos_suite


def test_render_sarif_report_and_cli_sarif_out(tmp_path: Path) -> None:
    clean = run_builtin_chaos_suite(simulate_lying_agent=False)
    sarif_clean = render_sarif_report(clean)
    assert sarif_clean["version"] == "2.1.0"
    assert sarif_clean["runs"][0]["results"] == []

    lying = run_builtin_chaos_suite(simulate_lying_agent=True)
    sarif_lying = render_sarif_report(lying)
    assert len(sarif_lying["runs"][0]["results"]) >= 1
    assert all(r["ruleId"] == "MCP001" for r in sarif_lying["runs"][0]["results"])

    sarif_file = tmp_path / "out.sarif"
    rc = cli_main(["audit", "--sarif-out", str(sarif_file), "--json"])
    assert rc == 0 and sarif_file.is_file()
    loaded = json.loads(sarif_file.read_text(encoding="utf-8"))
    assert loaded["version"] == "2.1.0"


def test_action_yml_marketplace_manifest_and_privacy() -> None:
    root = Path(__file__).resolve().parent.parent
    action_path = root / "action.yml"
    assert action_path.is_file()
    txt = action_path.read_text(encoding="utf-8")
    for token in ("MCP Guard", "sarif-out", "verdict", "hallucinations", "pay.staai.click"):
        assert token in txt
    assert "daochienthangkt" not in txt.lower()
    assert "gmail.com" not in txt.lower()
