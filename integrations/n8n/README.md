# Verify an MCP result inside n8n

Import `mcp-guard.workflow.json` from the workflow menu and execute **Run example**. The success output contains `verified: true`, the request ID and the original tool result. The example runs locally with no credentials.

For a private test in n8n 2.48.8, configure an Execute Sub-workflow node in a caller to take the workflow JSON from its **Define Below** source. Send the example input to that node. The embedded workflow returns `verified: true` and `requestId: example-1`. A caller that selects the imported workflow **from the database** requires a published version in that n8n workspace. The downloaded template imports as inactive. An empty call fails the guard.

In a calling workflow, use the HTTP Request node's full response option to retain the status and JSON body. Map the following fields, then call this workflow using **Execute Sub-workflow**. Keep error handling set to **Stop Workflow**. Attach actions such as billing, sending an email or updating inventory only to the successful output.

| Input | Meaning |
|---|---|
| `statusCode` | Integer HTTP status from the actual response |
| `expectedId` | JSON-RPC ID from the original request |
| `body` | Parsed JSON-RPC 2.0 response for `tools/call` |
| `requiredKeys` | Optional array of business fields required in structured content, or in a single JSON text block |

To observe a rejected tool call, set `isError: true` inside the example's `result`. Leave the HTTP status at 200. Execution stops at **Verify MCP before continuing**. A mismatched ID, RPC error, malformed content, HTTP failure or missing required business field also stops the batch. SSE streams must first be decoded into a final JSON-RPC response.

### Reproduce the benchmark

From the repository root run `python -m mcp_guard benchmark --trials 60 --seed 42`. The Python harness injects reproducible failures and reports verified outcomes. The workflow is independently testable with `node --test integrations/n8n/workflow.test.cjs`. Use recorded examples from your own tool to check the fields that actually matter to your application.

[Import workflows in n8n](https://docs.n8n.io/workflows/export-import/) · [MCP tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
