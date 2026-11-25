import { USDC, TOKEN_PROGRAM, decode58, newReference, solanaLink } from "./payments.mjs";
import { digest } from "./delivery.mjs";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, Authorization",
  "access-control-expose-headers": "PAYMENT-REQUIRED, X-PAYMENT-RESPONSE",
  "cache-control": "no-store",
};

const REFERENCE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ERROR_SIGNAL_RE = /\b(error|failed|failure|exception|permission denied|unauthorized|forbidden|rate limit|timed? ?out|etimedout|429|500|502|503|504|rejected|invalid token|not found)\b/i;
const SUCCESS_CLAIM_RE = /\b(successfully|completed|all done|verified|created|updated|saved|succeeded|done|passed)\b/i;
const HONEST_FAIL_RE = /\b(failed|error|unable|could not|blocked|timed out|rate limit|partial|incomplete|missing|denied|malformed)\b/i;

export const X402_ENDPOINTS = {
  "/api/v1/x402/mcp-audit": {
    path: "/api/v1/x402/mcp-audit",
    name: "MCP Tool Call Anti-Hallucination Audit",
    description: "Deterministic verification of up to 100 MCP tool_response + agent_claim traces (catches HTTP-200 silent failures, GraphQL errors[], truncated JSON & partial batches).",
    micros: 50000,
    amountUsdc: "0.05",
    label: "x402: MCP Audit",
    inputExample: {
      traces: [
        {
          case_id: "c1",
          tool_name: "create_invoice",
          fault_id: "silent_error_200",
          tool_response: { status_code: 200, body: { paid: false, error: "card_declined" } },
          agent_claim: "Invoice paid successfully!",
          required_keys: ["invoice_id"],
        },
      ],
    },
  },
  "/api/v1/x402/price-extract": {
    path: "/api/v1/x402/price-extract",
    name: "SSRF-Safe Structured Price Extractor",
    description: "Extracts normalized integer-cents price and stock state from Schema.org JSON-LD (AggregateOffer), Shopify JSON, Steam, GOG, JSON-Path, or SSRF-checked HTTPS URLs.",
    micros: 50000,
    amountUsdc: "0.05",
    label: "x402: Price Extract",
    inputExample: {
      adapter: "jsonld",
      currency: "USD",
      html: "<script type=\"application/ld+json\">{\"@type\":\"Product\",\"name\":\"Widget\",\"offers\":{\"@type\":\"Offer\",\"price\":\"19.00\",\"priceCurrency\":\"USD\",\"availability\":\"https://schema.org/InStock\"}}</script>",
    },
  },
};

function xJson(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: { ...CORS_HEADERS, ...extraHeaders } });
}

function toB64Json(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64Json(raw) {
  try {
    const bin = atob(raw.trim());
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function parsePaymentHeader(req) {
  const raw = (req.headers.get("x-payment") || req.headers.get("payment-signature") || "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object"
        ? { signature: String(obj.signature || obj.txSignature || obj.payload?.signature || "").trim(), reference: String(obj.reference || obj.payload?.reference || "").trim() }
        : null;
    } catch {
      return null;
    }
  }
  const decoded = fromB64Json(raw);
  if (decoded && typeof decoded === "object") {
    return {
      signature: String(decoded.signature || decoded.txSignature || decoded.payload?.signature || "").trim(),
      reference: String(decoded.reference || decoded.payload?.reference || "").trim(),
    };
  }
  return { signature: raw, reference: "" };
}

export async function verifyX402Transfer(env, signature, expectedMicros, reference = "") {
  if (decode58(signature).length !== 64) return "invalid";
  const wallet = env.MERCHANT_WALLET;
  if (!REFERENCE_RE.test(wallet || "")) throw new Error("Merchant wallet invalid");
  const response = await fetch(env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Solana RPC unavailable");
  const payload = await response.json();
  if (payload.error || !payload.result) return "pending";
  const tx = payload.result;
  if (!tx?.meta || tx.meta.err || tx.transaction?.signatures?.[0] !== signature) return "mismatch";
  if (!Number.isFinite(tx.blockTime) || tx.blockTime * 1000 < Date.now() - 86400000) return "mismatch";
  const msg = tx.transaction.message;
  const keys = [
    ...(msg.accountKeys || []),
    ...(tx.meta.loadedAddresses?.writable || []),
    ...(tx.meta.loadedAddresses?.readonly || []),
  ];
  let refIndex = -1;
  if (reference) {
    refIndex = keys.indexOf(reference);
    if (refIndex < 0) return "mismatch";
  }
  const postBalances = tx.meta.postTokenBalances || [];
  const preBalances = tx.meta.preTokenBalances || [];
  const minUnits = BigInt(expectedMicros);
  const ok = (msg.instructions || []).some(ix => {
    if (keys[ix.programIdIndex] !== TOKEN_PROGRAM || !Array.isArray(ix.accounts)) return false;
    const raw = decode58(ix.data);
    const checked = raw[0] === 12;
    if (checked ? raw.length !== 10 || raw[9] !== 6 : raw[0] !== 3 || raw.length !== 9) return false;
    if (checked && keys[ix.accounts[1]] !== USDC) return false;
    if (refIndex >= 0 && !ix.accounts.slice(checked ? 4 : 3).includes(refIndex)) return false;
    const dest = ix.accounts[checked ? 2 : 1];
    const post = postBalances.find(b => b.accountIndex === dest && b.owner === wallet && b.mint === USDC);
    if (!post || post.uiTokenAmount?.decimals !== 6) return false;
    const pre = preBalances.find(b => b.accountIndex === dest && b.mint === USDC);
    let units = 0n;
    for (let i = 8; i > 0; i--) units = (units << 8n) + BigInt(raw[i]);
    const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount?.amount || "0");
    return units >= minUnits && delta >= minUnits;
  });
  return ok ? "confirmed" : "mismatch";
}

function detectToolFailure(resp, requiredKeys = []) {
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return { failed: true, reasons: ["invalid_response_type"] };
  const reasons = [];
  const result = resp.jsonrpc === "2.0" ? resp.result : resp;
  if (result && typeof result === "object" && !Array.isArray(result) &&
      ("content" in result || "structuredContent" in result || "isError" in result)) {
    if (result.isError === true) reasons.push("mcp_is_error_true");
    if (requiredKeys.length) {
      let data = result.structuredContent;
      if (data == null && Array.isArray(result.content) && result.content.length === 1 && result.content[0] && typeof result.content[0] === "object") {
        try { data = JSON.parse(String(result.content[0].text || "")); } catch {}
      }
      const missing = requiredKeys.filter(k => !data || typeof data !== "object" || !(k in data));
      if (missing.length) reasons.push(`missing_required_keys=${missing.join(",")}`);
    }
    if (!Array.isArray(result.content) && (!result.structuredContent || typeof result.structuredContent !== "object")) {
      reasons.push("invalid_mcp_content");
    }
    if (resp.ok === false || resp.truncated || resp.error) reasons.push("transport_error");
    if (typeof resp.status_code === "number" && (resp.status_code === 207 || resp.status_code >= 400)) {
      reasons.push(`http_status_${resp.status_code}`);
    }
    return { failed: reasons.length > 0, reasons };
  }

  if (resp.ok === false) reasons.push("tool_ok_false");
  if (typeof resp.status_code === "number" && (resp.status_code >= 400 || resp.status_code === 207)) {
    reasons.push(`http_status_${resp.status_code}`);
  }
  if (resp.error) reasons.push(`explicit_error:${String(resp.error).slice(0, 60)}`);
  if (resp.truncated) reasons.push("truncated_flag_true");

  const rawText = typeof resp.raw_text === "string" ? resp.raw_text : null;
  let body = resp.body ?? null;
  if (rawText !== null && rawText.trim() && body === null) {
    try { body = JSON.parse(rawText); } catch { reasons.push("malformed_json_payload"); }
  }
  if (body === null && !(rawText !== null && rawText.trim())) reasons.push("empty_payload");
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (Number(body.failed || 0) > 0) reasons.push(`partial_failure_count=${body.failed}`);
    if (body.errors && (!Array.isArray(body.errors) || body.errors.length > 0)) reasons.push("body_contains_errors_list");
    if (body.paid === false) reasons.push("silent_decline_paid_false");
    if (body.ok === false) reasons.push("body_ok_false");
    if ("rowCount" in body && Number(body.rowCount) === 0 && (body.sqlstate || body.command)) {
      reasons.push("zero_rowcount_mutation");
    }
    if (requiredKeys.length) {
      const missing = requiredKeys.filter(k => !(k in body));
      if (missing.length) reasons.push(`missing_required_keys=${missing.join(",")}`);
    }
  }
  const blob = `${rawText || ""} ${body !== null ? JSON.stringify(body) : ""}`;
  if (ERROR_SIGNAL_RE.test(blob)) reasons.push("silent_error_signal_in_body");
  return { failed: reasons.length > 0, reasons };
}

export function auditMcpTraces(input) {
  const list = Array.isArray(input?.traces) ? input.traces : (input?.tool_response ? [input] : null);
  if (!list || !list.length || list.length > 100) {
    throw new Error("Expected 'traces' array (1..100 items) or a single trace object with 'tool_response'");
  }
  const results = list.map((tr, idx) => {
    const reqKeys = Array.isArray(tr?.required_keys) ? tr.required_keys.map(String) : [];
    const { failed, reasons } = detectToolFailure(tr?.tool_response, reqKeys);
    const claim = String(tr?.agent_claim || "").trim();
    const claimedSuccess = SUCCESS_CLAIM_RE.test(claim) && !HONEST_FAIL_RE.test(claim);
    const hallucinated = failed && claimedSuccess;
    const falseNeg = !failed && HONEST_FAIL_RE.test(claim) && !claimedSuccess;
    let verdict = "PASS";
    if (hallucinated) {
      verdict = "FAIL_HALLUCINATION";
      reasons.push("agent_claimed_success_despite_tool_failure");
    } else if (falseNeg) {
      verdict = "FAIL_FALSE_NEGATIVE";
      reasons.push("agent_reported_failure_on_clean_tool_response");
    }
    return {
      case_id: String(tr?.case_id || `trace_${idx + 1}`),
      tool_name: String(tr?.tool_name || "unknown"),
      fault_id: String(tr?.fault_id || "unknown"),
      tool_actually_failed: failed,
      agent_claimed_success: claimedSuccess,
      hallucinated_success: hallucinated,
      verdict,
      reasons,
    };
  });
  const total = results.length;
  const passed = results.filter(r => r.verdict === "PASS").length;
  const hallucinations = results.filter(r => r.hallucinated_success).length;
  const falseNegatives = results.filter(r => r.verdict === "FAIL_FALSE_NEGATIVE").length;
  const failedTools = results.filter(r => r.tool_actually_failed).length;
  return {
    ok: true,
    service: "mcp-guard-x402",
    total,
    passed,
    hallucinations,
    false_negatives: falseNegatives,
    false_positive_rate_pct: failedTools ? Math.round((hallucinations / failedTools) * 10000) / 100 : 0,
    verdict: hallucinations === 0 && falseNegatives === 0 ? "PASS" : "FAIL",
    results,
  };
}

function isUnsafeHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host === "localhost.localdomain" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts.some(n => n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  }
  return false;
}

function validateSafeHttpsUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || "").trim()); } catch { throw new Error("Valid https URL required"); }
  if (u.protocol !== "https:" || u.username || u.password || isUnsafeHost(u.hostname)) {
    throw new Error("Unsafe or non-HTTPS URL rejected");
  }
  return u;
}

async function safeHttpsFetch(startUrl) {
  let cur = startUrl;
  for (let hop = 0; hop <= 5; hop++) {
    validateSafeHttpsUrl(cur);
    const resp = await fetch(cur, {
      redirect: "manual",
      headers: { "user-agent": "DealMonitor-x402/1.2 (+https://pay.staai.click)" },
      signal: AbortSignal.timeout(10000),
    });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("location");
      if (!loc) throw new Error("Redirect missing Location");
      cur = validateSafeHttpsUrl(new URL(loc, cur)).toString();
      continue;
    }
    if (!resp.ok) throw new Error(`Upstream HTTP ${resp.status}`);
    return resp;
  }
  throw new Error("Too many redirects");
}

function toCents(val) {
  const s = String(val ?? "").trim().replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) throw new Error("Invalid decimal price");
  const num = Number(s);
  if (!Number.isFinite(num) || num < 0 || num > 10000000) throw new Error("Invalid decimal price");
  return Math.round(num * 100);
}

function collectJsonLdProducts(node, out = []) {
  if (Array.isArray(node)) {
    for (const entry of node) collectJsonLdProducts(entry, out);
  } else if (node && typeof node === "object") {
    const t = node["@type"];
    if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) out.push(node);
    if ("@graph" in node) collectJsonLdProducts(node["@graph"], out);
  }
  return out;
}

function offerPrice(offer) {
  if (offer.price !== undefined && offer.price !== null) return offer.price;
  if (String(offer["@type"] || "").toLowerCase() === "aggregateoffer" && offer.lowPrice !== undefined && offer.lowPrice !== null) {
    return offer.lowPrice;
  }
  const spec = offer.priceSpecification;
  if (Array.isArray(spec)) {
    const found = spec.find(x => x && typeof x === "object" && x.price !== undefined && x.price !== null);
    if (found) return found.price;
  } else if (spec && typeof spec === "object" && spec.price !== undefined && spec.price !== null) {
    return spec.price;
  }
  return null;
}

function offerMatchesCurrency(offer, currency) {
  if (!currency || offer.priceCurrency === currency) return true;
  const spec = offer.priceSpecification;
  if (Array.isArray(spec)) return spec.some(x => x && typeof x === "object" && x.priceCurrency === currency);
  if (spec && typeof spec === "object") return spec.priceCurrency === currency;
  return false;
}

function parseJsonLdHtml(htmlText, item) {
  const blocks = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(htmlText || ""))) !== null) {
    try { blocks.push(JSON.parse(m[1])); } catch {}
  }
  const prods = collectJsonLdProducts(blocks).filter(p => !item.sku || String(p.sku) === String(item.sku));
  if (prods.length !== 1) throw new Error("Expected exactly one matching JSON-LD Product");
  let offers = prods[0].offers || [];
  if (!Array.isArray(offers)) offers = [offers];
  const cands = offers.filter(o => o && typeof o === "object" && offerMatchesCurrency(o, item.currency) && offerPrice(o) !== null);
  if (cands.length !== 1) throw new Error("Expected one matching Offer in requested currency");
  const o = cands[0];
  const avail = String(o.availability || "InStock").split("/").pop();
  const priceCents = toCents(offerPrice(o));
  return {
    adapter: "jsonld",
    product_name: String(prods[0].name || item.name || ""),
    currency: String(o.priceCurrency || item.currency || "USD"),
    price_cents: priceCents,
    price: priceCents / 100,
    in_stock: avail === "InStock",
  };
}

function parseStructuredJson(payload, item) {
  const adapter = item.adapter;
  if (adapter === "shopify_json") {
    const product = payload?.product;
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    if (!variants.length) throw new Error("Missing Shopify product variants");
    let matches = variants;
    if (item.variant_id) matches = variants.filter(v => String(v.id || "") === String(item.variant_id));
    else if (item.sku) matches = variants.filter(v => String(v.sku || "") === String(item.sku));
    else if (variants.length > 1) throw new Error("Multiple Shopify variants — specify sku or variant_id");
    if (matches.length !== 1) throw new Error("Shopify variant must match exactly one item");
    const v = matches[0];
    const pc = toCents(v.price);
    return { adapter, product_name: String(product.title || ""), currency: item.currency || "USD", price_cents: pc, price: pc / 100, in_stock: Boolean(v.available ?? (v.inventory_quantity !== 0)) };
  }
  if (adapter === "steam") {
    const appid = String(item.sku || Object.keys(payload || {})[0] || "");
    const entry = payload?.[appid];
    if (!entry?.success) throw new Error("Unsuccessful Steam payload");
    if (entry.data?.is_free) return { adapter, product_name: String(entry.data?.name || ""), currency: item.currency || "USD", price_cents: 0, price: 0, in_stock: true };
    const po = entry.data?.price_overview;
    if (!po || (item.currency && po.currency !== item.currency)) throw new Error("Missing or mismatched Steam price_overview");
    return { adapter, product_name: String(entry.data?.name || ""), currency: po.currency, price_cents: Number(po.final), price: Number(po.final) / 100, in_stock: true };
  }
  if (adapter === "gog") {
    const prices = payload?._embedded?.prices || [];
    const row = prices.find(r => r?.currency?.code === (item.currency || "USD"));
    if (!row) throw new Error("GOG currency unavailable");
    const [amt] = String(row.finalPrice || "").split(" ");
    if (!/^\d+$/.test(amt)) throw new Error("Invalid GOG minor units");
    return { adapter, product_name: String(item.name || ""), currency: row.currency.code, price_cents: Number(amt), price: Number(amt) / 100, in_stock: true };
  }
  if (adapter === "json_path") {
    if (!item.price_path) throw new Error("json_path requires price_path");
    let cur = payload;
    for (const part of String(item.price_path).split(".")) {
      if (part === "__proto__" || part === "constructor" || part === "prototype") {
        throw new Error("Invalid json_path segment");
      }
      if (Array.isArray(cur)) {
        if (!/^\d+$/.test(part)) throw new Error(`Expected array index at '${part}'`);
        cur = cur[Number(part)];
      } else if (cur && typeof cur === "object" && Object.hasOwn(cur, part)) {
        cur = cur[part];
      } else {
        throw new Error(`Missing key '${part}' in json_path`);
      }
      if (cur === undefined) throw new Error(`Missing key '${part}' in json_path`);
    }
    const mult = Number(item.price_multiplier ?? 100);
    const pc = Math.round(Number(cur) * mult);
    if (!Number.isFinite(pc) || pc < 0) throw new Error("Invalid extracted price");
    return { adapter, product_name: String(item.name || ""), currency: item.currency || "USD", price_cents: pc, price: pc / 100, in_stock: true };
  }
  throw new Error("Unsupported adapter (use jsonld, shopify_json, steam, gog, json_path)");
}

export function validatePriceInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected JSON object");
  const adapter = String(body.adapter || "jsonld");
  if (!["jsonld", "shopify_json", "steam", "gog", "json_path"].includes(adapter)) {
    throw new Error("Unsupported adapter");
  }
  if (body.url && !body.html && !body.json_payload) {
    validateSafeHttpsUrl(body.url);
  } else if (!body.html && !body.json_payload) {
    throw new Error("Provide 'url' (https) or inline 'html'/'json_payload'");
  }
  if (adapter === "json_path" && !String(body.price_path || "").trim()) {
    throw new Error("json_path adapter requires price_path");
  }
}

export async function extractPricePayload(body) {
  validatePriceInput(body);
  const adapter = String(body.adapter || "jsonld");
  const item = { ...body, adapter, currency: String(body.currency || "USD") };
  if (body.html) {
    return { ok: true, service: "deal-monitor-x402", source: "inline_html", ...parseJsonLdHtml(body.html, item) };
  }
  if (body.json_payload !== undefined) {
    return { ok: true, service: "deal-monitor-x402", source: "inline_json", ...parseStructuredJson(body.json_payload, item) };
  }
  const resp = await safeHttpsFetch(body.url);
  if (adapter === "jsonld") {
    return { ok: true, service: "deal-monitor-x402", source: body.url, ...parseJsonLdHtml(await resp.text(), item) };
  }
  return { ok: true, service: "deal-monitor-x402", source: body.url, ...parseStructuredJson(await resp.json(), item) };
}

function catalogManifest(origin) {
  return {
    x402Version: 1,
    service: "MCP Guard Studio & Deal Monitor x402 Gateway",
    network: "solana-mainnet",
    asset: USDC,
    currency: "USDC",
    paymentHeaders: ["X-PAYMENT", "PAYMENT-SIGNATURE"],
    discovery: origin + "/.well-known/x402.json",
    endpoints: Object.values(X402_ENDPOINTS).map(ep => ({
      path: ep.path,
      method: "POST",
      name: ep.name,
      description: ep.description,
      maxAmountRequired: String(ep.micros),
      amountUsdc: ep.amountUsdc,
      inputExample: ep.inputExample,
    })),
    selfHostedBundles: {
      soloProV12: origin + "/checkout?sku=solo",
      teamCiPackV12: origin + "/checkout?sku=team",
      dealMonitorV12: origin + "/checkout?sku=deal-monitor",
    },
  };
}

export async function handleX402(req, env, url, origin) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method === "GET" && (url.pathname === "/.well-known/x402.json" || url.pathname === "/api/v1/x402/catalog")) {
    return xJson(catalogManifest(origin));
  }
  const ep = X402_ENDPOINTS[url.pathname];
  if (!ep || req.method !== "POST") return xJson({ error: "Unknown x402 route" }, 404);
  if (!env.COMMERCE_DB || !REFERENCE_RE.test(env.MERCHANT_WALLET || "")) {
    return xJson({ error: "x402 gateway temporarily unavailable" }, 503);
  }

  const pay = parsePaymentHeader(req);
  if (!pay || !pay.signature) {
    const reference = newReference();
    const challenge = {
      x402Version: 1,
      error: "Payment Required",
      accepts: [
        {
          scheme: "exact",
          network: "solana-mainnet",
          maxAmountRequired: String(ep.micros),
          amountUsdc: ep.amountUsdc,
          asset: USDC,
          payTo: env.MERCHANT_WALLET,
          resource: origin + ep.path,
          description: ep.description,
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
          extra: {
            reference,
            solanaPayUrl: solanaLink(env.MERCHANT_WALLET, { reference, expected_micros: ep.micros }, ep.label),
          },
        },
      ],
    };
    return xJson(challenge, 402, { "payment-required": toB64Json(challenge) });
  }

  if (!req.headers.get("content-type")?.includes("application/json")) {
    return xJson({ error: "Expected application/json body" }, 400);
  }
  if (Number(req.headers.get("content-length")) > 131072) return xJson({ error: "Payload too large" }, 413);
  const rawBody = await req.text();
  if (rawBody.length > 131072) return xJson({ error: "Payload too large" }, 413);
  let body;
  try { body = JSON.parse(rawBody); } catch { return xJson({ error: "Invalid JSON body" }, 400); }

  // Validate request shape BEFORE consuming signature or hitting Solana RPC
  try {
    if (ep.path === "/api/v1/x402/mcp-audit") {
      auditMcpTraces(body);
    } else {
      validatePriceInput(body);
    }
  } catch (err) {
    return xJson({ error: err.message || "Invalid request payload" }, 400);
  }

  const reqHash = await digest(ep.path + ":" + rawBody);
  const existing = await env.COMMERCE_DB.prepare(
    "SELECT request_hash, response_json FROM x402_calls WHERE signature=?"
  ).bind(pay.signature).first();
  if (existing) {
    if (existing.request_hash === reqHash) {
      return xJson(JSON.parse(existing.response_json), 200, {
        "x-payment-response": toB64Json({ settled: true, replayed: true, signature: pay.signature, network: "solana-mainnet" }),
      });
    }
    return xJson({ error: "Payment signature already used for a different request" }, 409);
  }

  const verifyState = await verifyX402Transfer(env, pay.signature, ep.micros, pay.reference);
  if (verifyState === "pending") return xJson({ error: "Solana transaction pending finality — retry shortly", state: "pending" }, 202);
  if (verifyState !== "confirmed") {
    return xJson({ error: "Solana USDC transfer did not match required amount/wallet/finality", state: verifyState }, 402);
  }

  let result;
  try {
    result = ep.path === "/api/v1/x402/mcp-audit" ? auditMcpTraces(body) : await extractPricePayload(body);
  } catch (err) {
    return xJson({ error: err.message || "Extraction failed" }, 422);
  }

  const now = Date.now();
  const respText = JSON.stringify(result);
  const ins = await env.COMMERCE_DB.prepare(
    "INSERT OR IGNORE INTO x402_calls(signature,endpoint,reference,amount_micros,request_hash,response_json,created_at) VALUES(?,?,?,?,?,?,?)"
  ).bind(pay.signature, ep.path, pay.reference || "", ep.micros, reqHash, respText, now).run();

  if (ins.meta.changes === 0) {
    const raced = await env.COMMERCE_DB.prepare(
      "SELECT request_hash, response_json FROM x402_calls WHERE signature=?"
    ).bind(pay.signature).first();
    if (raced?.request_hash === reqHash) {
      return xJson(JSON.parse(raced.response_json), 200, {
        "x-payment-response": toB64Json({ settled: true, replayed: true, signature: pay.signature, network: "solana-mainnet" }),
      });
    }
    return xJson({ error: "Payment signature already used for a different request" }, 409);
  }

  // Record synthetic telemetry event into visits + commerce_events so svhome learning loop tracks x402 USDC revenue
  const vh = await digest("x402:" + pay.signature);
  const visitId = `${vh.slice(0, 8)}-${vh.slice(8, 12)}-4${vh.slice(13, 16)}-8${vh.slice(17, 20)}-${vh.slice(20, 32)}`;
  await env.COMMERCE_DB.prepare(
    "INSERT OR IGNORE INTO visits(id,radar_ref,variant,created_at,exploration) VALUES(?,'','control',?,0)"
  ).bind(visitId, now).run();
  await env.COMMERCE_DB.prepare(
    "INSERT INTO commerce_events(visit_id,stage,reference,signature,amount_cents,release_id,at) VALUES(?,'paid',?,?,?, ?,?)"
  ).bind(visitId, pay.reference || ("x402:" + pay.signature.slice(0, 12)), pay.signature, Math.round(ep.micros / 10000), ep.path, now).run();

  return xJson(result, 200, {
    "x-payment-response": toB64Json({ settled: true, replayed: false, signature: pay.signature, network: "solana-mainnet" }),
  });
}
