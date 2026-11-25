import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, "bin", "mcp-guard-x402.mjs");

function startMockGateway() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let parsedBody = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {}
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: parsedBody,
    });

    if (req.url === "/api/v1/x402/mcp-audit") {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-free-tier": "1",
        "x-free-remaining": "4",
        "x-free-limit": "5",
      });
      res.end(
        JSON.stringify({
          ok: true,
          service: "mcp-guard-x402",
          total: 1,
          passed: 0,
          hallucinations: 1,
          verdict: "FAIL",
          freemium: { used: 1, limit: 5, remaining: 4, upgrade_x402_usdc: "0.05" },
        })
      );
      return;
    }

    if (req.url === "/api/v1/x402/pr-critic") {
      const challenge = {
        x402Version: 1,
        error: "Payment Required",
        trial_exhausted: true,
        accepts: [
          {
            scheme: "exact",
            network: "solana-mainnet",
            maxAmountRequired: "150000",
            amountUsdc: "0.15",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            payTo: "GPrbk8Lj3ZBCM26TzE3Zv1Dg9z2pJwMaZuc7sA5qCEXF",
            resource: `http://127.0.0.1/api/v1/x402/pr-critic`,
            description: "PR Diff Critic & Anti-Hallucination Gate",
            extra: {
              reference: "RefPubkey1111111111111111111111111111111111",
              solanaPayUrl:
                "solana:GPrbk8Lj3ZBCM26TzE3Zv1Dg9z2pJwMaZuc7sA5qCEXF?amount=0.15&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=RefPubkey1111111111111111111111111111111111",
            },
          },
        ],
      };
      const b64 = Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": b64,
      });
      res.end(JSON.stringify(challenge));
      return;
    }

    if (req.url === "/api/v1/x402/quant-overfit-score") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "quant-overfit-score-x402",
          verdict: "APPROVED_EDGE",
          deflated_sharpe_prob: 0.9812,
        })
      );
      return;
    }

    if (req.url === "/api/v1/x402/stealth-extract") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "stealth-extract-x402",
          title: "Example Page",
          headings: [{ level: 1, text: "Hello" }],
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        calls,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

function createMcpClient(envOverrides = {}) {
  const child = spawn(process.execPath, [BIN_PATH], {
    env: { ...process.env, ...envOverrides },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  const pending = new Map();

  child.stderr.on("data", chunk => {
    stderrBuf += chunk.toString("utf8");
  });

  child.stdout.on("data", chunk => {
    stdoutBuf += chunk.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  });

  function sendNotification(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  function request(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id}). stderr=${stderrBuf}`));
      }, 10000);
      pending.set(id, {
        resolve: msg => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function close() {
    child.stdin.end();
    await new Promise(resolve => child.once("close", resolve));
  }

  return { request, sendNotification, close, getStderr: () => stderrBuf };
}

test("Stdio MCP Server: initialize -> tools/list -> 200 trial -> 402 quota exhausted -> paid X-PAYMENT", async t => {
  const gw = await startMockGateway();
  t.after(() => gw.close());

  const client = createMcpClient({ MCP_GUARD_API_BASE: gw.baseUrl });
  t.after(() => client.close());

  // 1. initialize
  const initResp = await client.request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  assert.equal(initResp.jsonrpc, "2.0");
  assert.equal(initResp.id, 1);
  assert.equal(initResp.result.protocolVersion, "2024-11-05");
  assert.equal(initResp.result.serverInfo.name, "mcp-guard-x402");
  assert.ok(initResp.result.capabilities.tools);

  // 2. notifications/initialized (must produce no response)
  client.sendNotification("notifications/initialized", {});

  // 3. tools/list
  const listResp = await client.request(2, "tools/list", {});
  assert.equal(listResp.id, 2);
  const names = listResp.result.tools.map(x => x.name);
  assert.deepEqual(names, [
    "audit_mcp_response",
    "critic_git_diff",
    "score_quant_overfit",
    "stealth_extract_url",
  ]);
  for (const tool of listResp.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
  }

  // 4. tools/call -> 200 OK via default X-MCP-Trial: 1
  const auditResp = await client.request(3, "tools/call", {
    name: "audit_mcp_response",
    arguments: {
      tool_name: "charge",
      tool_response: { status_code: 200, body: { paid: false, error: "card_declined" } },
      agent_claim: "Payment succeeded!",
    },
  });
  assert.equal(auditResp.result.isError, false);
  const auditParsed = JSON.parse(auditResp.result.content[0].text);
  assert.equal(auditParsed.hallucinations, 1);
  assert.equal(auditParsed.freemium.remaining, 4);
  assert.equal(gw.calls[0].url, "/api/v1/x402/mcp-audit");
  assert.equal(gw.calls[0].headers["x-mcp-trial"], "1");
  assert.equal(gw.calls[0].headers["x-payment"], undefined);

  // 5. tools/call -> 402 Payment Required returns structured Solana Pay / x402 payment details
  const criticResp = await client.request(4, "tools/call", {
    name: "critic_git_diff",
    arguments: { diff: "diff --git a/a.py b/a.py\n+x = 1\n" },
  });
  assert.equal(criticResp.result.isError, true);
  const criticParsed = JSON.parse(criticResp.result.content[0].text);
  assert.equal(criticParsed.status, 402);
  assert.equal(criticParsed.trial_exhausted, true);
  assert.match(criticParsed.message, /Free daily quota/i);
  assert.equal(criticParsed.x402.amount_usdc, "0.15");
  assert.equal(criticParsed.x402.pay_to, "GPrbk8Lj3ZBCM26TzE3Zv1Dg9z2pJwMaZuc7sA5qCEXF");
  assert.equal(criticParsed.x402.reference, "RefPubkey1111111111111111111111111111111111");
  assert.ok(criticParsed.x402.solana_pay_url.startsWith("solana:"));

  // 6. tools/call -> explicit payment_signature + payment_reference sends X-PAYMENT & strips payment keys from JSON body
  const quantResp = await client.request(5, "tools/call", {
    name: "score_quant_overfit",
    arguments: {
      returns: Array(25).fill(0.004),
      n_trials: 3,
      payment_signature: "5FakeSolanaSig11111111111111111111111111111111111111111111111111111",
      payment_reference: "RefPubkey1111111111111111111111111111111111",
    },
  });
  assert.equal(quantResp.result.isError, false);
  const quantParsed = JSON.parse(quantResp.result.content[0].text);
  assert.equal(quantParsed.verdict, "APPROVED_EDGE");
  const quantCall = gw.calls[2];
  assert.equal(quantCall.url, "/api/v1/x402/quant-overfit-score");
  assert.equal(quantCall.headers["x-mcp-trial"], undefined);
  assert.deepEqual(JSON.parse(quantCall.headers["x-payment"]), {
    signature: "5FakeSolanaSig11111111111111111111111111111111111111111111111111111",
    reference: "RefPubkey1111111111111111111111111111111111",
  });
  assert.equal(quantCall.body.payment_signature, undefined);
  assert.equal(quantCall.body.payment_reference, undefined);

  // 7. tools/call -> stealth_extract_url
  const extResp = await client.request(6, "tools/call", {
    name: "stealth_extract_url",
    arguments: { html: "<html><head><title>Example Page</title></head><body><h1>Hello</h1></body></html>" },
  });
  assert.equal(extResp.result.isError, false);
  assert.equal(JSON.parse(extResp.result.content[0].text).title, "Example Page");

  // 8. Unknown tool -> JSON-RPC -32602 error
  const unknownResp = await client.request(7, "tools/call", { name: "nonexistent_tool", arguments: {} });
  assert.equal(unknownResp.error.code, -32602);

  assert.equal(client.getStderr(), "");
});

test("Stdio MCP Server honors MCP_GUARD_X402_PAYMENT env var by default", async t => {
  const gw = await startMockGateway();
  t.after(() => gw.close());

  const client = createMcpClient({
    MCP_GUARD_API_BASE: gw.baseUrl,
    MCP_GUARD_X402_PAYMENT: "EnvPaymentSig11111111111111111111111111111111111111111111111111111",
  });
  t.after(() => client.close());

  await client.request(1, "initialize", { protocolVersion: "2024-11-05" });
  const resp = await client.request(2, "tools/call", {
    name: "stealth_extract_url",
    arguments: { html: "<h1>Hi</h1>" },
  });
  assert.equal(resp.result.isError, false);
  assert.equal(gw.calls[0].headers["x-payment"], "EnvPaymentSig11111111111111111111111111111111111111111111111111111");
  assert.equal(gw.calls[0].headers["x-mcp-trial"], undefined);
});
