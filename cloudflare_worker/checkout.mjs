function buyerCheckout() {
  const find = id => document.getElementById(id);
  const message = text => { find("status").textContent = text; };
  const storage = localStorage;
  const ref = new URL(location.href).searchParams.get("radar_ref") || "";
  const key = "mcp-pro-receipt:" + ref;
  const fragment = new URLSearchParams(location.hash.slice(1));
  let receipt = JSON.parse(storage.getItem(key) || "null") || {
    id: crypto.randomUUID(), access: crypto.randomUUID()
  };
  if (fragment.get("order") && fragment.get("access")) {
    receipt = { ...receipt, reference: fragment.get("order"), access: fragment.get("access") };
  }
  function save() { storage.setItem(key, JSON.stringify(receipt)); }
  function protect(handler) {
    return async event => {
      event?.preventDefault();
      const button = event?.submitter || event?.target?.closest("button");
      if (button) button.disabled = true;
      try { await handler(); }
      catch (error) { message(error.message || "Please try again."); }
      finally { if (button) button.disabled = false; }
    };
  }
  async function api(path, body, auth = false) {
    const headers = { "content-type": "application/json" };
    if (auth) headers.authorization = "Bearer " + receipt.access;
    const response = await fetch("/api/" + path, {
      method: "POST", headers, body: JSON.stringify(body), cache: "no-store"
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Payment did not match this order.");
    return result;
  }
  function showOrder() {
    find("begin").hidden = true;
    find("receipt").hidden = false;
    const hash = new URLSearchParams({ order: receipt.reference, access: receipt.access });
    history.replaceState(null, "", location.pathname + location.search + "#" + hash);
    if (receipt.payment_url) {
      find("pay").href = receipt.payment_url;
      find("pay").hidden = false;
    }
  }
  async function status() {
    const result = await api("status", { reference: receipt.reference }, true);
    if (result.state === "paid") {
      find("download").href = result.download;
      find("download").hidden = false;
      find("pay").hidden = true;
      find("confirm").hidden = true;
      message(result.email_accepted ? "Payment confirmed. Email accepted for delivery." :
        "Payment confirmed. Your download is ready here.");
    } else {
      if (result.payment_url) { find("pay").href = result.payment_url; find("pay").hidden = false; }
      message("Waiting for a finalized payment. Pay once using this order’s wallet link.");
    }
  }
  async function begin() {
    if (receipt.reference) { showOrder(); await status(); return; }
    const visit = await api("visit", { id: receipt.id, radar_ref: ref });
    find("offer").textContent = visit.variant === "ci" ?
      "Catch a failed tool call before merging your next release." :
      "Run 24 reusable fault scenarios across five MCP integrations.";
    save();
    find("begin").hidden = false;
    message("");
  }
  find("begin").addEventListener("submit", protect(async () => {
    const order = await api("checkout", { visit: receipt.id, access: receipt.access, email: find("email").value });
    receipt.reference = order.reference;
    receipt.payment_url = order.payment_url;
    save();
    showOrder();
    await status();
  }));
  find("refresh").addEventListener("click", protect(status));
  find("confirm").addEventListener("submit", protect(async () => {
    const result = await api("confirm", { reference: receipt.reference, signature: find("signature").value.trim() }, true);
    if (result.state === "pending") message("The transaction has not finalized yet. Check again shortly.");
    else await status();
  }));
  protect(begin)();
}

export function checkoutPage(amount) {
  const nonce = crypto.randomUUID();
  const response = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>MCP Guard Kit Pro checkout</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: "Inter", system-ui, sans-serif; }
  body { max-width: 40rem; margin: 8vh auto; padding: 1.25rem; line-height: 1.55; }
  h1 { font-size: 1.75rem; }
  form { display: grid; gap: .6rem; margin: 1rem 0; }
  input, button, .action { font: inherit; padding: .55rem .8rem; border-radius: .35rem; }
  button, .action { cursor: pointer; }
  .action { display: inline-block; }
  [hidden] { display: none !important; }
</style></head><body>
<main><h1>MCP Guard Kit Pro · ${amount} USDC</h1>
<p id="offer">One-time purchase on Solana mainnet.</p>
<form id="begin" hidden><label for="email">Delivery email</label>
<input id="email" type="email" autocomplete="email" maxlength="254" required>
<button>Create payment link</button></form>
<section id="receipt" hidden><h2>Your private receipt</h2>
<p>Bookmark this page privately to reopen your order or renew a download link.
Anyone with the receipt link can access the order.</p>
<a class="action" id="pay" hidden>Pay in Solana wallet</a>
<a class="action" id="download" hidden>Download Pro ZIP</a>
<button type="button" id="refresh">Check payment</button>
<form id="confirm"><label for="signature">Already paid? Verify your transaction signature</label>
<input id="signature" maxlength="100" required><button>Verify payment</button></form></section>
<p role="status" aria-live="polite" id="status">Opening checkout…</p></main>
<script nonce="${nonce}">(${buyerCheckout.toString()})();</script></body></html>`;
  return new Response(response, { headers: {
    "content-type": "text/html;charset=UTF-8", "cache-control": "private, no-store",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  } });
}
