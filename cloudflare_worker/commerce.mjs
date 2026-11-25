import { resolveProduct, SKU_CATALOG } from "./catalog.mjs";
import { confirmPayment, newReference, reconcilePending, solanaLink } from "./payments.mjs";
import { deliverOrder, digest, downloadLink, getFile, retryDue, validToken } from "./delivery.mjs";
import { checkoutPage } from "./checkout.mjs";
import { handleX402 } from "./x402.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REFERENCE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RADAR = /^[0-9a-f]{24}_[1-9][0-9]{0,6}$/;

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function payload(req) {
  if (!req.headers.get("content-type")?.startsWith("application/json")) return null;
  if (Number(req.headers.get("content-length")) > 8192) return null;
  const body = await req.text();
  if (body.length > 8192) return null;
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

async function visit(db, body) {
  if (!UUID.test(body.id) || typeof body.radar_ref !== "string" ||
      (body.radar_ref && !RADAR.test(body.radar_ref))) return json({ error: "Invalid visit" }, 400);
  const now = Date.now();
  const rule = await db.prepare("SELECT winner FROM offer_policy WHERE radar_ref=? AND expires_at>?")
    .bind(body.radar_ref, now).first();
  const [bucket, arm] = crypto.getRandomValues(new Uint32Array(2));
  const exploration = !rule || bucket / 4294967296 < .2;
  const variant = exploration ? ((arm & 1) ? "ci" : "control") : rule.winner;
  await db.prepare("INSERT OR IGNORE INTO visits(id,radar_ref,variant,created_at,exploration) VALUES(?,?,?,?,?)")
    .bind(body.id, body.radar_ref, variant, now, Number(exploration)).run();
  const saved = await db.prepare("SELECT radar_ref,variant FROM visits WHERE id=?").bind(body.id).first();
  return saved.radar_ref === body.radar_ref ? json(saved) : json({ error: "Visit mismatch" }, 409);
}

async function start(env, body, legacy = false) {
  const db = env.COMMERCE_DB;
  if (legacy) {
    const key = await digest("legacy:" + body.reference_pubkey);
    const id = key.slice(0, 8) + "-" + key.slice(8, 12) + "-4" + key.slice(13, 16) +
      "-8" + key.slice(17, 20) + "-" + key.slice(20, 32);
    body = { ...body, visit: id, access: crypto.randomUUID() };
    await db.prepare("INSERT OR IGNORE INTO visits(id,radar_ref,variant,created_at) VALUES(?,'','control',?)")
      .bind(id, Date.now()).run();
    const existing = await db.prepare("SELECT email,visit_id FROM orders WHERE reference=?")
      .bind(body.reference_pubkey).first();
    if (existing && (existing.email !== String(body.email || "").trim() || existing.visit_id !== id))
      return json({ error: "Reference already used" }, 409);
    if (existing) return json({ ok: true, reference: body.reference_pubkey });
  }
  const email = String(body.email || "").trim();
  if (!UUID.test(body.visit) || !UUID.test(body.access) ||
      email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({ error: "Please enter a valid delivery email address." }, 400);
  if (!await db.prepare("SELECT id FROM visits WHERE id=?").bind(body.visit).first()) {
    const fallbackRef = typeof body.radar_ref === "string" && RADAR.test(body.radar_ref) ? body.radar_ref : "";
    await db.prepare("INSERT OR IGNORE INTO visits(id,radar_ref,variant,created_at,exploration) VALUES(?,?,?,?,1)")
      .bind(body.visit, fallbackRef, "control", Date.now()).run();
  }
  const product = resolveProduct(body.sku, env);
  if (!product) return json({ error: "Unknown product SKU" }, 400);
  const hash = await digest(body.access);
  const price = product.micros;
  if (!Number.isSafeInteger(price) || price < 10000 || price % 10000 || !REFERENCE.test(env.MERCHANT_WALLET))
    throw new Error("Invalid merchant settings");
  await db.prepare(
    "INSERT OR IGNORE INTO orders(reference,visit_id,email,access_hash,expected_micros,sku,created_at) VALUES(?,?,?,?,?,?,?)"
  ).bind(legacy ? body.reference_pubkey : newReference(), body.visit, email, hash, price, product.sku, Date.now()).run();
  const order = await db.prepare("SELECT * FROM orders WHERE visit_id=?").bind(body.visit).first();
  if (legacy && order?.reference === body.reference_pubkey && order.email === email) return json({ ok: true, reference: order.reference });
  if (!order || order.access_hash !== hash || order.email !== email) return json({ error: "Visit already used" }, 409);
  const orderProduct = resolveProduct(order.sku || product.sku, env) || product;
  return json({
    reference: order.reference,
    sku: orderProduct.sku,
    product_name: orderProduct.name,
    payment_url: solanaLink(env.MERCHANT_WALLET, order, orderProduct.name),
    amount: order.expected_micros / 1000000,
  });
}

async function receipt(req, env, body, operation, origin, ctx) {
  const auth = req.headers.get("authorization") || "";
  if (!REFERENCE.test(body.reference) || !auth.startsWith("Bearer ") || !UUID.test(auth.slice(7)))
    return json({ error: "Receipt required" }, 403);
  const db = env.COMMERCE_DB;
  const order = await db.prepare("SELECT * FROM orders WHERE reference=? AND access_hash=?")
    .bind(body.reference, await digest(auth.slice(7))).first();
  if (!order) return json({ error: "Receipt unavailable" }, 403);
  if (operation === "confirm") {
    const result = await confirmPayment(env, String(body.signature || ""), order);
    if (result !== "confirmed") return json({ state: result }, result === "pending" ? 202 : 422);
    ctx.waitUntil(deliverOrder(env, order.reference, origin));
  }
  if (operation === "usage") {
    if (!order.signature || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(body.release || ""))
      return json({ error: "Paid order and release ID required" }, 400);
    await db.prepare("INSERT OR IGNORE INTO usage_releases(reference,release_id,used_at) VALUES(?,?,?)")
      .bind(order.reference, body.release, Date.now()).run();
    return json({ accepted: true });
  }
  const current = await db.prepare("SELECT signature,mail_id,sku,expected_micros FROM orders WHERE reference=?")
    .bind(order.reference).first();
  const product = resolveProduct(current.sku || "", env);
  if (!current.signature) {
    return json({
      state: "awaiting_payment",
      sku: product.sku,
      product_name: product.name,
      amount: current.expected_micros / 1000000,
      payment_url: solanaLink(env.MERCHANT_WALLET, { ...order, expected_micros: current.expected_micros }, product.name),
    });
  }
  return json({
    state: "paid",
    sku: product.sku,
    product_name: product.name,
    filename: product.filename,
    amount: current.expected_micros / 1000000,
    email_accepted: Boolean(current.mail_id),
    download: await downloadLink(origin, env, current.signature),
  });
}

async function webhook(req, env, origin, ctx) {
  if (!env.HELIUS_AUTH_SECRET || !(await safeEqual(req.headers.get("authorization") || "", env.HELIUS_AUTH_SECRET)))
    return json({ error: "Unauthorized" }, 401);
  let events;
  try { events = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!Array.isArray(events) || events.length > 100) return json({ error: "Invalid event batch" }, 400);
  let confirmed = 0;
  let pending = false;
  for (const event of events) {
    if (!event?.signature || event.transactionError) continue;
    const transfers = event.tokenTransfers || [];
    if (!transfers.some(t => t.toUserAccount === env.MERCHANT_WALLET)) continue;
    const keys = [...new Set((event.instructions || []).flatMap(ix => ix.accounts || []))]
      .filter(key => typeof key === "string" && REFERENCE.test(key));
    // D1 limits bound parameters. Query chunks, never assemble external values into SQL.
    for (let i = 0; i < keys.length; i += 60) {
      const chunk = keys.slice(i, i + 60);
      const { results } = await env.COMMERCE_DB.prepare(
        "SELECT * FROM orders WHERE reference IN (" + chunk.map(() => "?").join(",") + ")"
      ).bind(...chunk).all();
      for (const order of results) {
        const state = await confirmPayment(env, event.signature, order);
        if (state === "pending") pending = true;
        if (state !== "confirmed") continue;
        confirmed++;
        ctx.waitUntil(deliverOrder(env, order.reference, origin));
      }
    }
  }
  return json({ confirmed, pending }, pending ? 503 : 200);
}

async function setPolicy(req, env) {
  if (!env.COMMERCE_POLICY_TOKEN ||
      !await safeEqual(req.headers.get("authorization") || "", "Bearer " + env.COMMERCE_POLICY_TOKEN))
    return json({ error: "Unauthorized" }, 401);
  const body = await payload(req);
  if (!body || !Array.isArray(body.policies) || body.policies.length > 128 ||
      body.policies.some(p => !p || (p.radar_ref !== "" && !RADAR.test(p.radar_ref)) ||
        !["control","ci"].includes(p.winner))) return json({ error: "Invalid policy" }, 400);
  const db = env.COMMERCE_DB;
  const expiry = Date.now() + 14 * 86400000;
  const commands = [db.prepare("DELETE FROM offer_policy")];
  for (const item of body.policies) commands.push(
    db.prepare("INSERT INTO offer_policy(radar_ref,winner,expires_at) VALUES(?,?,?)")
      .bind(item.radar_ref, item.winner, expiry)
  );
  await db.batch(commands);
  return json({ updated: body.policies.length });
}

async function feed(req, env, url) {
  if (!env.COMMERCE_FEED_TOKEN || !(await safeEqual(req.headers.get("authorization") || "", "Bearer " + env.COMMERCE_FEED_TOKEN)))
    return json({ error: "Unauthorized" }, 401);
  const after = Number(url.searchParams.get("after") || 0);
  if (!Number.isSafeInteger(after) || after < 0) return json({ error: "Invalid cursor" }, 400);
  const result = await env.COMMERCE_DB.prepare(
    `SELECT e.*, v.variant, v.radar_ref, v.exploration FROM commerce_events e JOIN visits v ON v.id=e.visit_id
     WHERE e.id>? ORDER BY e.id LIMIT 100`
  ).bind(after).all();
  return json({ events: result.results });
}

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const origin = env.PUBLIC_ORIGIN || url.origin;
  if (req.method === "GET" && url.pathname === "/") return json({ ok: true, service: "mcp-guard-solana-fulfillment", x402_catalog: origin + "/.well-known/x402.json" });
  if (url.pathname === "/.well-known/x402.json" || url.pathname.startsWith("/api/v1/x402/")) {
    return handleX402(req, env, url, origin);
  }
  if (req.method === "GET" && url.pathname === "/checkout") {
    if (!env.COMMERCE_DB || !env.HMAC_SECRET || !(env.PRO_FILES || env.PRO_FILES_KV || env.PRO_ZIP_PRIVATE_URL))
      return json({ error: "Checkout unavailable" }, 503);
    const reqSku = String(url.searchParams.get("sku") || "solo").trim().toLowerCase();
    const initial = SKU_CATALOG[reqSku] ? reqSku : "solo";
    return checkoutPage((SKU_CATALOG[initial] || SKU_CATALOG.solo).micros / 1000000, {
      wallet: env.MERCHANT_WALLET,
      sender: env.SENDER_EMAIL,
      replyTo: env.REPLY_TO_EMAIL,
      sku: initial,
      catalog: SKU_CATALOG,
    });
  }
  if (req.method === "GET" && url.pathname === "/download") {
    const sig = url.searchParams.get("sig");
    if (!await validToken(sig, url.searchParams.get("token"), env.HMAC_SECRET))
      return json({ error: "Expired or invalid download link" }, 403);
    return getFile(env, sig);
  }
  if (req.method === "POST" && url.pathname === "/api/funnel/policy") return setPolicy(req, env);
  if (req.method === "GET" && url.pathname === "/api/funnel/events") return feed(req, env, url);
  if (req.method === "POST" && url.pathname === "/api/helius-webhook") return webhook(req, env, origin, ctx);
  if (req.method === "POST" && ["/api/visit","/api/checkout","/api/status","/api/confirm","/api/usage"].includes(url.pathname)) {
    if (req.headers.has("origin") && req.headers.get("origin") !== url.origin)
      return json({ error: "Origin mismatch" }, 403);
    const body = await payload(req);
    if (!body) return json({ error: "Expected JSON object" }, 400);
    if (url.pathname === "/api/visit") return visit(env.COMMERCE_DB, body);
    if (url.pathname === "/api/checkout") {
      if (!env.HMAC_SECRET || !(env.PRO_FILES || env.PRO_FILES_KV || env.PRO_ZIP_PRIVATE_URL)) return json({ error: "Checkout unavailable" }, 503);
      if (body.reference_pubkey && !body.visit && !REFERENCE.test(body.reference_pubkey))
        return json({ error: "Invalid reference" }, 400);
      return start(env, body, Boolean(body.reference_pubkey && !body.visit));
    }
    return receipt(req, env, body, url.pathname.split("/").pop(), origin, ctx);
  }
  return json({ error: "Unknown route" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try { return await route(req, env, ctx); }
    catch { return json({ error: "Service unavailable. Your receipt can be retried." }, 503); }
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await reconcilePending(env); }
      finally { await retryDue(env); }
    })());
  }
};
