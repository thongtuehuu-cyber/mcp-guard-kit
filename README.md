# MCP Guard Kit

[![CI](https://github.com/thongtuehuu-cyber/mcp-guard-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/thongtuehuu-cyber/mcp-guard-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)

**Zero-dependency MCP tool fault-injection & anti-hallucination verifier for AI agents.**

When an MCP tool fails silently (HTTP 200 with error body, truncated JSON, partial batch failure, schema drift, or malformed streams), LLMs and naive `status_code == 200` checks routinely assume success.

### Reproducible Benchmark (`python -m mcp_guard benchmark --trials 60 --seed 42`)
Across 60 deterministic trials (`48` faulted calls spanning all 8 fault categories + `12` clean baselines, saved in [`docs/benchmark_results.json`](docs/benchmark_results.json)):
- **Naive HTTP-200 Verifier:** missed **`36 / 48` (`75.0%`)** of faulted MCP responses (6 of 8 fault categories return HTTP 200 / `ok=true`).
- **`mcp-guard` Evidence Verifier:** caught **`48 / 48` (`100.0%`)** with **`0`** false alarms on clean payloads.

`mcp-guard-kit` catches lying agents deterministically in CI — zero SaaS lock-in, zero external dependencies.

**Live Comparison & Interactive Calculator:** https://thongtuehuu-cyber.github.io/mcp-guard-kit/

## Quick Start

```bash
pip install -e .

# Run the built-in 10-case MCP chaos audit (8 fault modes + 2 clean baselines)
python -m mcp_guard audit --html-out report.html --md-out report.md

# Simulate an LLM hallucinating success on 33% of tool failures (exits non-zero for CI)
python -m mcp_guard audit --simulate-lying-agent --json
```

## 8 Built-In MCP Fault Modes

| Fault ID | Category | What It Catches |
|---|---|---|
| `timeout` | Transport | Agent claims success after `504 ETIMEDOUT` |
| `malformed_json` | Serialization | Agent guesses missing fields from broken JSON |
| `empty_payload` | Contract | Agent fabricates records on `200 OK` + empty body |
| `silent_error_200` | Semantic | HTTP `200` hiding `"Permission denied / written: 0"` |
| `http_429_rate_limit` | Quota | Agent ignores `429 Retry-After` and fakes completion |
| `schema_drift` | Contract | Required keys renamed/dropped silently defaulting to `0` |
| `partial_failure` | Consistency | `207` batch `1 succeeded / 4 failed` summarized as "all done" |
| `truncated_response` | Transport | Mid-stream cut payload extrapolated by the LLM |

## Python API

```python
from mcp_guard import FaultInjector, ToolTrace, verify_trace

injector = FaultInjector(seed=42)
broken_resp = injector.inject("silent_error_200")

res = verify_trace(
    ToolTrace(
        case_id="write-01",
        tool_name="save_invoice",
        fault_id="silent_error_200",
        tool_response=broken_resp,
        agent_claim="Successfully saved invoice!",
    )
)
assert res.verdict == "FAIL_HALLUCINATION"
```

## Pro Automation Suite v1.2 & Deal Monitor ($19–$79 USDC · 0% Fee)

Need live JSON-RPC protocol proxies, 30 production chaos scenarios, native pytest fixtures, policy gates, and security-gate reports out of the box? **MCP Guard Kit Pro v1.2** adds:

- **30 Production MCP Chaos Scenarios** across **Stripe, GitHub, Postgres, Slack, Playwright & MCP Core** (`96 / 96 = 100.0%` caught, `0` false alarms in the 120-trial `seed=42` benchmark)
- **Live `proxy-stdio` & Streamable-HTTP Chaos Proxies** wrapping real upstream MCP servers (stderr-safe framing, `--rules-file`, JSONL capture)
- **Policy Gates, Scaffolding & Regression Replay**: `mcp-guard-pro init`, `--policy` JSON gates, `distill` / `replay` sanitized trace generator
- **Native Pytest Plugin (`pytest11`)**: `mcp_chaos`, `mcp_assert_honest`, `mcp_stdio_proxy`, `mcp_http_proxy`
- **SARIF 2.1.0, JUnit XML & Executive HTML Reports** + ready-to-use GitHub Actions PR gate + perpetual commercial license

Instant automated checkout on Solana Mainnet USDC (QR + 7-day signed ZIP delivery, no account required):

- **[Solo Pro v1.2 — 19 USDC](https://pay.staai.click/checkout?sku=solo&utm_source=github&utm_medium=readme)** (`mcp-guard-kit-pro-v1.2.zip`)
- **[Team CI Pack v1.2 — 79 USDC](https://pay.staai.click/checkout?sku=team&utm_source=github&utm_medium=readme)** (unlimited org repos & CI runners)
- **[Deal Monitor Self-Hosted v1.2 — 19 USDC](https://pay.staai.click/checkout?sku=deal-monitor&utm_source=github&utm_medium=readme)** (`deal-monitor-self-hosted-v1.2.zip` — 6 price adapters, SQLite retry outbox for Discord/Telegram/ntfy/Webhook, SSRF redirect guard & Docker)

Overview & interactive fault simulator: [live landing page](https://thongtuehuu-cyber.github.io/mcp-guard-kit/#pro-pack).
