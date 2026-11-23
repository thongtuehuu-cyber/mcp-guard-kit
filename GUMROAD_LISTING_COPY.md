# Gumroad / LemonSqueezy Ready-to-Publish Listing — MCP Guard Kit Pro v1.1 ($3.25)

- **Product Name:** MCP Guard Kit Pro v1.1 — Live MCP Chaos Proxies & Anti-Hallucination Verifier
- **Price:** $3.25 (One-time, lifetime v1.x updates)
- **Tagline:** Stop AI agents from lying when Stripe, GitHub, Postgres, Slack, or Playwright MCP tools fail silently. Drop in live stdio/HTTP chaos proxies & CI gates in 5 minutes.
- **Upload File:** `e:\DEV\products\dist\mcp-guard-kit-pro-v1.1.zip`
- **Public Open-Core Funnel:** https://github.com/thongtuehuu-cyber/mcp-guard-kit
- **Live SEO/AEO Demo Site:** https://thongtuehuu-cyber.github.io/mcp-guard-kit/

## Sales Copy (Ready to Paste)
When an MCP tool returns HTTP 200 with `ok: false`, `paid: false`, `rowCount: 0`, GraphQL `errors[]`, truncated JSON, or a `207` partial batch failure, LLMs routinely tell users **"All done!"** — and in our reproducible 60-trial benchmark (`seed=42`), naive HTTP-200 verifiers missed **75.0% (36/48)** of silent failures (and **72/96 (75.0%)** in our 120-trial Pro MCP benchmark), while MCP Guard caught **100.0%** with **0** false alarms.

**MCP Guard Kit Pro v1.1 ($3.25 one-time, zero dependencies, Python 3.10+)** gives your engineering team:
1. **24 Production MCP Chaos Scenarios** across **Stripe (5)**, **GitHub (5)**, **Postgres (5)**, **Slack (5)**, and **Playwright (4)** with real JSON-RPC 2.0 `tools/call` envelopes.
2. **Live `StdioMCPChaosProxy` & `HTTPMCPChaosProxy`** (`proxy-stdio` / `proxy-http`): wrap real upstream MCP servers, inject deterministic faults/delays/corrupted streams by tool glob or call index, and record JSONL traces.
3. **Native Pytest Plugin (`pytest11`)**: `mcp_chaos`, `mcp_assert_honest`, `mcp_stdio_proxy`, `mcp_http_proxy`, plus `--mcp-chaos-seed`.
4. **Protocol-Aware Multi-Layer Verifier & Quantitative Contradiction Catcher**: distinguishes honest partial failure reporting from hallucinated completion.
5. **SARIF 2.1.0, JUnit XML & Executive HTML Reports** + ready-to-copy GitHub Actions PR gate + perpetual commercial license.
