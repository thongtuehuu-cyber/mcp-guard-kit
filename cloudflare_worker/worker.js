/**
 * Cloudflare Worker: Zero-Cost 24/7 Solana USDC Auto-Fulfillment for MCP Guard Kit Pro ($29).
 * Privacy-first: Buyer emails live ONLY in Cloudflare KV keyed by order_id — NEVER written on-chain.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Register pending order (called from checkout form before buyer signs Solana Pay tx)
    if (request.method === "POST" && url.pathname === "/api/order") {
      const body = await request.json();
      const email = String(body.email || "").trim();
      const reference = String(body.reference || "").trim();
      if (!email.includes("@") || !reference) {
        return json({ error: "email and reference pubkey required" }, 400);
      }
      await env.ORDERS_KV.put(`ref:${reference}`, JSON.stringify({ email, createdAt: Date.now(), status: "pending" }), {
        expirationTtl: 86400 * 7,
      });
      return json({ ok: true, reference });
    }

    // 2. Helius Enhanced Webhook for incoming Solana mainnet USDC transfers -> verify >= 29 USDC -> email ZIP link
    if (request.method === "POST" && url.pathname === "/api/helius-webhook") {
      const auth = request.headers.get("authorization") || "";
      if (env.HELIUS_AUTH_SECRET && auth !== env.HELIUS_AUTH_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }
      const events = await request.json();
      let fulfilled = 0;
      for (const tx of Array.isArray(events) ? events : []) {
        const sig = tx.signature || "";
        for (const t of tx.tokenTransfers || []) {
          const validMint = t.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
          const validDest = t.toUserAccount === env.MERCHANT_WALLET;
          const validAmt = Number(t.tokenAmount || 0) >= 28.9;
          if (!validMint || !validDest || !validAmt) continue;

          // Match reference key present in accountData keys
          const keys = (tx.accountData || []).map((a) => a.account);
          for (const k of keys) {
            const raw = await env.ORDERS_KV.get(`ref:${k}`);
            if (!raw) continue;
            const order = JSON.parse(raw);
            if (order.status === "fulfilled") continue;

            const dlToken = await signDownloadToken(sig, env.HMAC_SECRET, Date.now() + 86400_000 * 7);
            const downloadUrl = `${url.origin}/download?sig=${encodeURIComponent(sig)}&token=${encodeURIComponent(dlToken)}`;
            await sendBrevoDelivery(env, order.email, downloadUrl, sig);
            await env.ORDERS_KV.put(`ref:${k}`, JSON.stringify({ ...order, status: "fulfilled", sig }));
            fulfilled += 1;
          }
        }
      }
      return json({ ok: true, fulfilled });
    }

    // 3. HMAC-verified Pro zip redirect/download endpoint
    if (request.method === "GET" && url.pathname === "/download") {
      const sig = url.searchParams.get("sig") || "";
      const token = url.searchParams.get("token") || "";
      const valid = await verifyDownloadToken(sig, token, env.HMAC_SECRET);
      if (!valid) return new Response("Invalid or expired license link.", { status: 403 });
      return Response.redirect(env.PRO_ZIP_PRIVATE_URL, 302);
    }

    return json({ ok: true, service: "mcp-guard-solana-fulfillment" });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function signDownloadToken(sig, secret, expMs) {
  const payload = `${sig}.${expMs}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${expMs}.${hex}`;
}

async function verifyDownloadToken(sig, token, secret) {
  const [expStr, hex] = String(token).split(".");
  const exp = Number(expStr || 0);
  if (!exp || Date.now() > exp || !hex) return false;
  const expected = await signDownloadToken(sig, secret, exp);
  return expected === token;
}

async function sendBrevoDelivery(env, toEmail, downloadUrl, txSig) {
  if (!env.BREVO_API_KEY) return;
  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      sender: { name: "MCP Guard Studio", email: env.SENDER_EMAIL },
      to: [{ email: toEmail }],
      subject: "Your MCP Guard Kit Pro v1.0 License & Download",
      textContent: `Thank you for purchasing MCP Guard Kit Pro!\n\nDownload link (valid 7 days):\n${downloadUrl}\n\nSolana Tx: ${txSig}\n`,
    }),
  });
}
