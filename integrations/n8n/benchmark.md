# Catch silent MCP tool failures in an n8n workflow

A stock lookup can return HTTP 200, a matching JSON-RPC ID and a tool result that says the lookup failed. If the next node decrements inventory, a transport-only success check lets an invalid update reach the business system.

We ran 60 deterministic trials against the MCP Guard Kit Python verifier with seed 42. The fixture generator injected 48 failures. A status-only verifier missed 36 of those 48. The guard detected all 48 and accepted the 12 healthy fixtures. These are synthetic runs with known outcomes. They measure failure detection on this fixture set.

## Reproduce the result

Run `python -m mcp_guard benchmark --trials 60 --seed 42` from the repository root. Inspect the per-fault results alongside the count of healthy runs. For a production tool, capture redacted responses and add cases drawn from actual incidents.

## Use the n8n template

Import `mcp-guard.workflow.json` and run the manual example. The request identifies the expected response ID and requires a SKU. The guard checks HTTP status, the JSON-RPC envelope, correlation, tool errors and the required business fields before it releases a value to the next node. Change the example's `result.isError` to `true` and run it again. The node stops execution even though the status is still 200.

For a live workflow, connect the output of an HTTP Request node to the sub-workflow trigger. Preserve the full status and body, pass the request ID from the original request, and keep **Stop Workflow** enabled. On a batch failure, the guard identifies the item index so an operator can inspect just that response.

[Open-source verifier and benchmark](https://github.com/thongtuehuu-cyber/mcp-guard-kit). [MCP tool result contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

For a team adding the checks to CI, the paid kit includes reusable CI templates. [Get MCP Guard Kit Pro]({{CHECKOUT}}).
