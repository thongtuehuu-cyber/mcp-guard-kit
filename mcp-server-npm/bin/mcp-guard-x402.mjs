#!/usr/bin/env node
/**
 * mcp-guard-x402 — Zero-dependency Stdio MCP Server (Node.js >= 18)
 *
 * Bridges Cursor, Claude Desktop, and any MCP JSON-RPC 2.0 host to the
 * pay.staai.click Freemium (5 free calls/day per IP via X-MCP-Trial: 1)
 * and Solana Mainnet USDC x402 pay-per-call verification gateway.
 */

const SERVER_NAME = "mcp-guard-x402";
const SERVER_VERSION = "1.2.0";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const DEFAULT_API_BASE = "https://pay.staai.click";
const DEFAULT_MERCHANT_WALLET = "GPrbk8Lj3ZBCM26TzE3Zv1Dg9z2pJwMaZuc7sA5qCEXF";
const DEFAULT_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const API_BASE = (process.env.MCP_GUARD_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
const TIMEOUT_MS = Math.max(2000, Math.min(60000, Number(process.env.MCP_GUARD_TIMEOUT_MS || 20000) || 20000));

const PAYMENT_PROPERTIES = {
  payment_signature: {
    type: "string",
    description:
      "Optional Solana Mainnet USDC transaction signature (or JSON/base64 x402 X-PAYMENT payload). Used after the 5 free daily calls are exhausted, or set env MCP_GUARD_X402_PAYMENT.",
  },
  payment_reference: {
    type: "string",
    description: "Optional Solana Pay reference pubkey returned by an HTTP 402 PAYMENT-REQUIRED challenge.",
  },
};

const TOOLS = [
  {
    name: "audit_mcp_response",
    endpoint: "/api/v1/x402/mcp-audit",
    amountUsdc: "0.05",
    micros: 50000,
    description:
      "Deterministic anti-hallucination audit of MCP tool responses + LLM agent claims. Catches silent HTTP-200 failures, GraphQL errors[], isError=true, truncated JSON, partial 207 batches, and missing required keys. 5 free calls/day via X-MCP-Trial, then $0.05 USDC via Solana x402.",
    inputSchema: {
      type: "object",
      properties: {
        traces: {
          type: "array",
          description: "Array of 1..100 MCP trace objects to verify.",
          items: {
            type: "object",
            properties: {
              case_id: { type: "string" },
              tool_name: { type: "string" },
              fault_id: { type: "string" },
              tool_response: { type: "object" },
              agent_claim: { type: "string" },
              required_keys: { type: "array", items: { type: "string" } },
            },
            required: ["tool_response"],
          },
        },
        case_id: { type: "string", description: "Single-trace shorthand: identifier for this audit case." },
        tool_name: { type: "string", description: "Single-trace shorthand: MCP tool name." },
        fault_id: { type: "string", description: "Single-trace shorthand: optional fault label." },
        tool_response: { type: "object", description: "Single-trace shorthand: raw MCP tool response object." },
        agent_claim: { type: "string", description: "Single-trace shorthand: LLM agent claim about the tool call." },
        required_keys: {
          type: "array",
          items: { type: "string" },
          description: "Single-trace shorthand: required keys expected in the tool response body.",
        },
        ...PAYMENT_PROPERTIES,
      },
    },
  },
  {
    name: "critic_git_diff",
    endpoint: "/api/v1/x402/pr-critic",
    amountUsdc: "0.15",
    micros: 150000,
    description:
      "Deterministic PR diff critic & anti-hallucination gate. Audits unified git diffs for .env/key/secret leaks, trivial assert-True or skipped tests, stray cache artifacts, and test-output vs pass-claim contradictions. 5 free calls/day via X-MCP-Trial, then $0.15 USDC via Solana x402.",
    inputSchema: {
      type: "object",
      properties: {
        diff: { type: "string", description: "Unified git diff string (non-empty, <= 120KB)." },
        files: { type: "array", items: { type: "string" }, description: "Optional explicit list of touched file paths." },
        test_output: { type: "string", description: "Optional raw pytest/jest/test runner output." },
        claimed_pass: { type: "boolean", description: "Whether the agent claimed tests passed." },
        max_files: { type: "integer", description: "Optional warning threshold for touched files (default 15)." },
        ...PAYMENT_PROPERTIES,
      },
      required: ["diff"],
    },
  },
  {
    name: "score_quant_overfit",
    endpoint: "/api/v1/x402/quant-overfit-score",
    amountUsdc: "0.25",
    micros: 250000,
    description:
      "Computes Bailey & Lopez de Prado Deflated Sharpe Ratio (DSR), multiple-testing noise haircut, 2x cost-stressed Sharpe, max drawdown, and Quarter-Kelly position cap on any paper-only return series (20..5000 returns). 5 free calls/day via X-MCP-Trial, then $0.25 USDC via Solana x402.",
    inputSchema: {
      type: "object",
      properties: {
        returns: {
          type: "array",
          items: { type: "number" },
          minItems: 20,
          description: "Periodic decimal returns series (20..5000 finite numbers in [-10, 10]).",
        },
        n_trials: { type: "integer", description: "Number of parameter/strategy trials tested (default 1)." },
        cost_bps: { type: "number", description: "One-way transaction cost in basis points (default 10)." },
        turnover_per_period: { type: "number", description: "Portfolio turnover per period in [0, 2] (default 0.25)." },
        periods_per_year: { type: "integer", description: "Annualization periods per year (default 252)." },
        ...PAYMENT_PROPERTIES,
      },
      required: ["returns"],
    },
  },
  {
    name: "stealth_extract_url",
    endpoint: "/api/v1/x402/stealth-extract",
    amountUsdc: "0.05",
    micros: 50000,
    description:
      "SSRF-safe structured extractor for page title, H1-H3 headings, Schema.org JSON-LD blocks, and normalized text from a public HTTPS URL or inline HTML. 5 free calls/day via X-MCP-Trial, then $0.05 USDC via Solana x402.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public HTTPS URL to fetch and extract (SSRF-checked)." },
        html: { type: "string", description: "Optional inline HTML string (skips remote fetch)." },
        max_chars: { type: "integer", description: "Maximum clean text excerpt characters (200..8000, default 2500)." },
        ...PAYMENT_PROPERTIES,
      },
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

let useContentLengthFraming = false;

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, "utf8");
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = data !== undefined ? { code, message, data } : { code, message };
  writeMessage({ jsonrpc: "2.0", id, error });
}

function decodeBase64Json(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(Buffer.from(raw.trim(), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function resolvePaymentHeader(args) {
  const sig = typeof args?.payment_signature === "string" ? args.payment_signature.trim() : "";
  const ref = typeof args?.payment_reference === "string" ? args.payment_reference.trim() : "";
  if (sig) {
    if (ref && !sig.startsWith("{")) {
      return JSON.stringify({ signature: sig, reference: ref });
    }
    return sig;
  }
  const envPay = String(process.env.MCP_GUARD_X402_PAYMENT || "").trim();
  return envPay || "";
}

function formatPaymentRequired(tool, status, bodyData, paymentRequiredHdr) {
  const challenge =
    (bodyData && typeof bodyData === "object" && bodyData.accepts ? bodyData : null) ||
    decodeBase64Json(paymentRequiredHdr) ||
    (bodyData && typeof bodyData === "object" ? bodyData : {});
  const accept = Array.isArray(challenge.accepts) && challenge.accepts[0] ? challenge.accepts[0] : {};
  const amountUsdc = String(accept.amountUsdc || tool.amountUsdc);
  const amountMicros = String(accept.maxAmountRequired || tool.micros);
  const payTo = String(accept.payTo || DEFAULT_MERCHANT_WALLET);
  const asset = String(accept.asset || DEFAULT_USDC_MINT);
  const network = String(accept.network || "solana-mainnet");
  const reference = String(accept.extra?.reference || "");
  const solanaPayUrl = String(accept.extra?.solanaPayUrl || "");
  const trialExhausted = Boolean(challenge.trial_exhausted);

  const summary = trialExhausted
    ? `Free daily quota (5 calls/day per IP) is exhausted for ${tool.name}. Send ${amountUsdc} USDC on Solana Mainnet to ${payTo} (or scan/open the Solana Pay URL) and retry with payment_signature + payment_reference, or configure MCP_GUARD_X402_PAYMENT.`
    : `Payment required (${amountUsdc} USDC on Solana Mainnet) for ${tool.name}. Send ${amountUsdc} USDC to ${payTo} and retry with payment_signature (and optional payment_reference) or set MCP_GUARD_X402_PAYMENT.`;

  const structured = {
    status,
    error: "payment_required",
    trial_exhausted: trialExhausted,
    message: summary,
    x402: {
      protocol: "x402-v1",
      network,
      currency: "USDC",
      amount_usdc: amountUsdc,
      amount_micros: amountMicros,
      asset,
      pay_to: payTo,
      reference,
      solana_pay_url: solanaPayUrl,
      resource: String(accept.resource || `${API_BASE}${tool.endpoint}`),
      retry_hint: "Pass payment_signature (finalized Solana tx signature) and payment_reference to this tool, or set env MCP_GUARD_X402_PAYMENT.",
      self_hosted_pro_pack: `${API_BASE}/checkout?sku=solo`,
    },
    raw_challenge: challenge,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  };
}

async function callRemoteTool(tool, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
  const paymentHeader = resolvePaymentHeader(args);

  const payload = { ...args };
  delete payload.payment_signature;
  delete payload.payment_reference;

  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": `${SERVER_NAME}/${SERVER_VERSION}`,
  };
  if (paymentHeader) {
    headers["x-payment"] = paymentHeader;
  } else {
    headers["x-mcp-trial"] = "1";
  }

  let resp;
  try {
    resp = await fetch(`${API_BASE}${tool.endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const netErr = {
      status: 0,
      error: "network_error",
      message: `Failed to reach ${API_BASE}${tool.endpoint}: ${err?.message || String(err)}`,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(netErr, null, 2) }],
      structuredContent: netErr,
      isError: true,
    };
  }

  const rawText = await resp.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = null;
  }

  if (resp.status === 402) {
    return formatPaymentRequired(tool, 402, data, resp.headers.get("payment-required"));
  }

  if (resp.status === 202) {
    const pendingPayload = {
      status: 202,
      state: "pending",
      message: data?.error || "Solana transaction is still pending finality. Retry shortly with the same payment_signature.",
      details: data,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(pendingPayload, null, 2) }],
      structuredContent: pendingPayload,
      isError: true,
    };
  }

  if (!resp.ok) {
    const errPayload = {
      status: resp.status,
      error: data?.error || `Gateway returned HTTP ${resp.status}`,
      details: data ?? rawText.slice(0, 1000),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(errPayload, null, 2) }],
      structuredContent: errPayload,
      isError: true,
    };
  }

  const resultData = data && typeof data === "object" ? data : { ok: true, raw: rawText };
  return {
    content: [{ type: "text", text: JSON.stringify(resultData, null, 2) }],
    structuredContent: resultData,
    isError: false,
  };
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    if (msg && msg.id !== undefined) {
      sendError(msg.id, -32600, "Invalid Request: expected JSON-RPC 2.0 object");
    }
    return;
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) {
    return;
  }

  if (method === "initialize") {
    const requestedVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : "2024-11-05";
    if (!isNotification) {
      sendResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        instructions:
          "MCP Guard x402 verification tools. Sends X-MCP-Trial: 1 automatically for 5 free calls/day per IP; after free quota is exhausted, returns exact Solana Mainnet USDC x402 payment details.",
      });
    }
    return;
  }

  if (method === "ping") {
    if (!isNotification) sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    if (!isNotification) {
      sendResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    }
    return;
  }

  if (method === "tools/call") {
    const toolName = typeof params?.name === "string" ? params.name : "";
    const tool = TOOL_MAP.get(toolName);
    if (!tool) {
      if (!isNotification) sendError(id, -32602, `Unknown tool: ${toolName}`);
      return;
    }
    const result = await callRemoteTool(tool, params?.arguments);
    if (!isNotification) sendResult(id, result);
    return;
  }

  if (!isNotification) {
    sendError(id, -32601, `Method not found: ${String(method)}`);
  }
}

let buffer = Buffer.alloc(0);
let inFlight = 0;
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && inFlight === 0) {
    process.exit(0);
  }
}

function dispatchJsonText(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, `Parse error: ${err.message}`);
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const msg of messages) {
    inFlight++;
    Promise.resolve()
      .then(() => handleRequest(msg))
      .catch(err => {
        if (msg && msg.id !== undefined && msg.id !== null) {
          sendError(msg.id, -32603, `Internal error: ${err?.message || String(err)}`);
        }
      })
      .finally(() => {
        inFlight--;
        maybeExit();
      });
  }
}

function drainBuffer(flushAll = false) {
  while (buffer.length > 0) {
    // Strip leading CR/LF
    let start = 0;
    while (start < buffer.length && (buffer[start] === 0x0a || buffer[start] === 0x0d)) {
      start++;
    }
    if (start > 0) buffer = buffer.subarray(start);
    if (buffer.length === 0) break;

    const headPreview = buffer.subarray(0, Math.min(buffer.length, 32)).toString("ascii");
    if (/^content-length\s*:/i.test(headPreview)) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headerStr = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length\s*:\s*(\d+)/i.exec(headerStr);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        sendError(null, -32700, "Parse error: malformed Content-Length header");
        continue;
      }
      const contentLen = Number(match[1]);
      const frameEnd = headerEnd + 4 + contentLen;
      if (buffer.length < frameEnd) return;
      useContentLengthFraming = true;
      const bodyStr = buffer.subarray(headerEnd + 4, frameEnd).toString("utf8");
      buffer = buffer.subarray(frameEnd);
      dispatchJsonText(bodyStr);
      continue;
    }

    const nlIndex = buffer.indexOf(0x0a);
    if (nlIndex === -1) {
      if (flushAll) {
        const rest = buffer.toString("utf8");
        buffer = Buffer.alloc(0);
        dispatchJsonText(rest);
      }
      return;
    }
    const line = buffer.subarray(0, nlIndex).toString("utf8");
    buffer = buffer.subarray(nlIndex + 1);
    dispatchJsonText(line);
  }
}

process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  drainBuffer(false);
});

process.stdin.on("end", () => {
  drainBuffer(true);
  stdinEnded = true;
  maybeExit();
});

process.stdin.resume();
