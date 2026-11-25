const { test } = require("node:test");
const assert = require("node:assert/strict");
const workflow = require("./mcp-guard.workflow.json");

const node = (name) => workflow.nodes.find((item) => item.name === name);
const example = () => Function(node("Example response").parameters.jsCode)()[0].json;
const validate = Function("$input", node("Verify MCP before continuing").parameters.jsCode);
const run = (...items) => validate({ all: () => items.map((json) => ({ json })) });

test("manual and sub-workflow entry points terminate at the same verifier", () => {
  assert.equal(workflow.active, false);
  for (const name of ["Example response", "From calling workflow"]) {
    assert.equal(workflow.connections[name].main[0][0].node, "Verify MCP before continuing");
  }
  assert.equal(run(example())[0].json.verified, true);
  const text = example();
  delete text.body.result.structuredContent;
  assert.equal(run(text)[0].json.requestId, text.expectedId);
});

const cases = [
  ["successful transport hides a tool failure", (v) => { v.body.result.isError = true; }],
  ["RPC error arrives inside HTTP 200", (v) => { v.body.error = { code: -32000 }; }],
  ["incorrect request correlation", (v) => { v.body.id = "other"; }],
  ["missing required field", (v) => { v.body.result.structuredContent = {}; }],
  ["null as the required value", (v) => { v.body.result.structuredContent.sku = null; }],
  ["failed transport", (v) => { v.statusCode = 429; }],
  ["partial success", (v) => { v.statusCode = 207; }],
  ["content with invalid text", (v) => { v.body.result.content = [{ type: "text", text: "" }]; }],
];
for (const [name, change] of cases) {
  test(name, () => {
    const bad = example();
    change(bad);
    assert.throws(() => run(example(), bad), /rejected item 1/);
  });
}
