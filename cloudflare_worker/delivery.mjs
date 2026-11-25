import { artifactKeyForProduct, resolveProduct } from "./catalog.mjs";

const encoder = new TextEncoder();
const WEEK = 7 * 86400000;

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function digest(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function key(secret, purpose) {
  if (!secret) throw new Error("Signing key unavailable");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [purpose]);
}

export async function issueToken(value, secret, expiry = Date.now() + WEEK) {
  const mac = await crypto.subtle.sign("HMAC", await key(secret, "sign"), encoder.encode(value + "." + expiry));
  return expiry + "." + hex(mac);
}

export async function validToken(value, token, secret) {
  if (!secret || !value || typeof token !== "string") return false;
  const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(token);
  if (!match || Number(match[1]) <= Date.now()) return false;
  const bytes = Uint8Array.from(match[2].match(/../g), s => parseInt(s, 16));
  return crypto.subtle.verify("HMAC", await key(secret, "verify"), bytes, encoder.encode(value + "." + match[1]));
}

export async function downloadLink(origin, env, signature) {
  const url = new URL("/download", origin);
  url.searchParams.set("sig", signature);
  url.searchParams.set("token", await issueToken(signature, env.HMAC_SECRET));
  return url.toString();
}

export async function getFile(env, signature) {
  const order = await env.COMMERCE_DB.prepare(
    "SELECT sku FROM orders WHERE signature=?"
  ).bind(signature).first();
  const product = resolveProduct(order?.sku || "", env);
  const artifactKey = artifactKeyForProduct(product, env);
  const downloadName = (product.filename || artifactKey).replace(/[^A-Za-z0-9._-]/g, "_");

  let body;
  if (env.PRO_FILES) {
    const object = (await env.PRO_FILES.get(artifactKey))
      || (artifactKey !== (env.PRO_ZIP_KEY || "mcp-guard-kit-pro-v1.1.zip")
        ? await env.PRO_FILES.get(env.PRO_ZIP_KEY || "mcp-guard-kit-pro-v1.1.zip")
        : null);
    body = object?.body;
  } else if (env.PRO_FILES_KV) {
    body = await env.PRO_FILES_KV.get(artifactKey, { type: "stream" });
    if (!body && artifactKey !== (env.PRO_ZIP_KEY || "mcp-guard-kit-pro-v1.1.zip")) {
      body = await env.PRO_FILES_KV.get(env.PRO_ZIP_KEY || "mcp-guard-kit-pro-v1.1.zip", { type: "stream" });
    }
  } else if (env.PRO_ZIP_PRIVATE_URL && new URL(env.PRO_ZIP_PRIVATE_URL).protocol === "https:") {
    const response = await fetch(env.PRO_ZIP_PRIVATE_URL, { redirect: "error", signal: AbortSignal.timeout(10000) });
    if (response.ok) body = response.body;
  }
  if (!body) throw new Error("Release artifact unavailable");
  await env.COMMERCE_DB.prepare(
    "UPDATE orders SET downloaded_at=? WHERE signature=? AND downloaded_at IS NULL"
  ).bind(Date.now(), signature).run();
  return new Response(body, { headers: {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${downloadName}"`,
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer"
  } });
}

export async function deliverOrder(env, reference, origin) {
  const db = env.COMMERCE_DB;
  const lease = crypto.randomUUID();
  const now = Date.now();
  const order = await db.prepare(
    `UPDATE orders SET lease=?, lease_until=?, attempts=attempts+1
     WHERE reference=? AND paid_at IS NOT NULL AND mail_id IS NULL AND lease_until<=? AND next_try<=?
     RETURNING *`
  ).bind(lease, now + 120000, reference, now, now).first();
  if (!order) return false;
  try {
    if (!env.SENDER_EMAIL || (!env.RESEND_API_KEY && !env.BREVO_API_KEY)) {
      throw new Error("Mail configuration missing");
    }
    const product = resolveProduct(order.sku || "", env);
    const link = await downloadLink(origin, env, order.signature);
    const subject = `Your ${product.name} download`;
    const text = `Thank you for purchasing ${product.name} (${order.expected_micros / 1000000} USDC)!\n\n` +
      `File: ${product.filename}\n` +
      "Your download link is valid for seven days:\n" + link +
      "\n\nSolana Tx: " + order.signature +
      "\n\nYour private checkout receipt can generate a fresh link anytime.";
    let messageId = "";
    if (env.RESEND_API_KEY) {
      const payload = {
        from: `MCP Guard Studio <${env.SENDER_EMAIL}>`,
        to: [order.email],
        subject,
        text,
      };
      if (env.REPLY_TO_EMAIL) payload.reply_to = env.REPLY_TO_EMAIL;
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: "Bearer " + env.RESEND_API_KEY,
          "content-type": "application/json",
          "idempotency-key": order.reference,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Resend returned " + response.status);
      const data = await response.json();
      messageId = typeof data?.id === "string" ? data.id.trim() : "";
    } else {
      const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST", headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          sender: { name: "MCP Guard Studio", email: env.SENDER_EMAIL },
          to: [{ email: order.email }],
          headers: { idempotencyKey: order.reference },
          subject,
          textContent: text,
        }), signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error("Brevo returned " + response.status);
      const data = await response.json();
      messageId = typeof data?.messageId === "string" ? data.messageId.trim() : "";
    }
    if (!messageId) throw new Error("Missing provider message ID");
    const saved = await db.prepare(
      "UPDATE orders SET mail_id=?, emailed_at=?, lease=NULL, lease_until=0 WHERE reference=? AND lease=?"
    ).bind(messageId, Date.now(), reference, lease).run();
    return saved.meta.changes === 1;
  } catch {
    const delay = Math.min(6 * 3600000, 60000 * 2 ** Math.min(order.attempts - 1, 9));
    await db.prepare(
      "UPDATE orders SET next_try=?, lease=NULL, lease_until=0 WHERE reference=? AND lease=?"
    ).bind(Date.now() + delay, reference, lease).run();
    return false;
  }
}

export async function retryDue(env) {
  if (!env.PUBLIC_ORIGIN) throw new Error("Checkout origin missing");
  const now = Date.now();
  const due = await env.COMMERCE_DB.prepare(
    `SELECT reference FROM orders WHERE paid_at IS NOT NULL AND mail_id IS NULL
     AND next_try<=? AND lease_until<=? ORDER BY next_try, created_at LIMIT 10`
  ).bind(now, now).all();
  for (const row of due.results) await deliverOrder(env, row.reference, env.PUBLIC_ORIGIN);
}
