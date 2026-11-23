function buyerCheckout() {
  const find = id => document.getElementById(id);
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
  let pollTimer = null;
  let pollRemaining = 0;

  function makeQrSvg(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const RS_M = [
      null,
      [1,26,16],[1,44,28],[1,70,44],[2,50,32],[2,67,43],
      [4,43,27],[4,49,31],[2,60,38,2,61,39],[3,58,36,2,59,37],[4,69,43,1,70,44],
      [1,80,50,4,81,51],[6,58,36,2,59,37],[8,59,37,1,60,38],[4,64,40,5,65,41],[5,65,41,5,66,42]
    ];
    const ALIGN = [
      null,[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],
      [6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70]
    ];
    const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
    for (let i = 0, x = 1; i < 255; i++) {
      EXP[i] = x; EXP[i + 255] = x; LOG[x] = i;
      x = x & 128 ? (x << 1) ^ 0x11d : x << 1;
    }
    const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
    const rsGen = deg => {
      let p = [1];
      for (let i = 0; i < deg; i++) {
        const next = new Array(p.length + 1).fill(0);
        for (let j = 0; j < p.length; j++) {
          next[j] ^= p[j];
          next[j + 1] ^= mul(p[j], EXP[i]);
        }
        p = next;
      }
      return p;
    };
    const rsEncode = (data, ecLen) => {
      const gen = rsGen(ecLen);
      const res = new Uint8Array(data.length + ecLen);
      res.set(data);
      for (let i = 0; i < data.length; i++) {
        const factor = res[i];
        if (!factor) continue;
        for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], factor);
      }
      return Array.from(res.slice(data.length));
    };
    let ver = 1;
    for (; ver <= 15; ver++) {
      const r = RS_M[ver];
      const dataCaps = r[0] * r[2] + (r[3] || 0) * (r[5] || 0);
      if (bytes.length * 8 + 4 + (ver < 10 ? 8 : 16) <= dataCaps * 8) break;
    }
    if (ver > 15) return null;
    const r = RS_M[ver];
    const totalData = r[0] * r[2] + (r[3] || 0) * (r[5] || 0);
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(4, 4);
    push(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, totalData * 8 - bits.length));
    while (bits.length & 7) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      cw.push(v);
    }
    for (let p = 0; cw.length < totalData; p++) cw.push(p & 1 ? 0x11 : 0xec);
    const blocks = [], ecLen = r[1] - r[2];
    let off = 0;
    for (let g = 0; g < r.length; g += 3) {
      for (let i = 0; i < r[g]; i++) {
        const d = cw.slice(off, off + r[g + 2]);
        off += r[g + 2];
        blocks.push({ d, e: rsEncode(d, ecLen) });
      }
    }
    const stream = [];
    const maxD = Math.max(...blocks.map(b => b.d.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) stream.push(b.d[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) stream.push(b.e[i]);
    const N = ver * 4 + 17;
    const build = mask => {
      const m = Array.from({ length: N }, () => new Int8Array(N).fill(-1));
      const finder = (r0, c0) => {
        for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
          const rr = r0 + dr, cc = c0 + dc;
          if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
          const on = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                     (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
                     (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
          m[rr][cc] = on ? 1 : 0;
        }
      };
      finder(0, 0); finder(0, N - 7); finder(N - 7, 0);
      for (const r0 of ALIGN[ver]) for (const c0 of ALIGN[ver]) {
        if ((r0 < 8 && c0 < 8) || (r0 < 8 && c0 >= N - 8) || (r0 >= N - 8 && c0 < 8)) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          m[r0 + dr][c0 + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (!dr && !dc)) ? 1 : 0;
        }
      }
      for (let i = 8; i < N - 8; i++) {
        if (m[6][i] === -1) m[6][i] = i & 1 ? 0 : 1;
        if (m[i][6] === -1) m[i][6] = i & 1 ? 0 : 1;
      }
      m[N - 8][8] = 1;
      const bch = (val, g) => {
        const gl = g.toString(2).length;
        let d = val << (gl - 1);
        while (d && d.toString(2).length >= gl) d ^= g << (d.toString(2).length - gl);
        return (val << (gl - 1)) | d;
      };
      const fmt = bch(mask, 0x537) ^ 0x5412;
      for (let i = 0; i < 15; i++) {
        const bit = (fmt >> i) & 1;
        if (i < 6) m[i][8] = bit; else if (i < 8) m[i + 1][8] = bit; else m[N - 15 + i][8] = bit;
        if (i < 8) m[8][N - 1 - i] = bit; else if (i < 9) m[8][15 - i] = bit; else m[8][14 - i] = bit;
      }
      if (ver >= 7) {
        const vinfo = bch(ver, 0x1f25);
        for (let i = 0; i < 18; i++) {
          const bit = (vinfo >> i) & 1;
          m[Math.floor(i / 3)][N - 11 + (i % 3)] = bit;
          m[N - 11 + (i % 3)][Math.floor(i / 3)] = bit;
        }
      }
      let idx = 0, bitIdx = 7, dir = -1;
      for (let col = N - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        for (let step = 0; step < N; step++) {
          const row = dir === -1 ? N - 1 - step : step;
          for (let dc = 0; dc < 2; dc++) {
            const c = col - dc;
            if (m[row][c] !== -1) continue;
            let dark = idx < stream.length ? ((stream[idx] >> bitIdx) & 1) : 0;
            if (--bitIdx < 0) { bitIdx = 7; idx++; }
            const inv = mask === 0 ? (row + c) % 2 === 0 :
                        mask === 1 ? row % 2 === 0 :
                        mask === 2 ? c % 3 === 0 :
                        mask === 3 ? (row + c) % 3 === 0 :
                        mask === 4 ? (Math.floor(row / 2) + Math.floor(c / 3)) % 2 === 0 :
                        mask === 5 ? (row * c) % 2 + (row * c) % 3 === 0 :
                        mask === 6 ? ((row * c) % 2 + (row * c) % 3) % 2 === 0 :
                                     ((row + c) % 2 + (row * c) % 3) % 2 === 0;
            m[row][c] = inv ? dark ^ 1 : dark;
          }
        }
        dir = -dir;
      }
      return m;
    };
    const score = m => {
      let pen = 0, dark = 0;
      for (let r = 0; r < N; r++) {
        let runR = 0, lastR = -1, runC = 0, lastC = -1;
        for (let c = 0; c < N; c++) {
          dark += m[r][c];
          runR = m[r][c] === lastR ? runR + 1 : 1; lastR = m[r][c];
          if (runR === 5) pen += 3; else if (runR > 5) pen++;
          runC = m[c][r] === lastC ? runC + 1 : 1; lastC = m[c][r];
          if (runC === 5) pen += 3; else if (runC > 5) pen++;
          if (r < N - 1 && c < N - 1 && m[r][c] === m[r][c+1] && m[r][c] === m[r+1][c] && m[r][c] === m[r+1][c+1]) pen += 3;
        }
      }
      for (let r = 0; r < N; r++) for (let c = 0; c < N - 6; c++) {
        const h = m[r][c] === 1 && m[r][c+1] === 0 && m[r][c+2] === 1 && m[r][c+3] === 1 && m[r][c+4] === 1 && m[r][c+5] === 0 && m[r][c+6] === 1;
        if (h && ((c >= 4 && !m[r][c-1] && !m[r][c-2] && !m[r][c-3] && !m[r][c-4]) || (c + 10 < N && !m[r][c+7] && !m[r][c+8] && !m[r][c+9] && !m[r][c+10]))) pen += 40;
        const v = m[c][r] === 1 && m[c+1][r] === 0 && m[c+2][r] === 1 && m[c+3][r] === 1 && m[c+4][r] === 1 && m[c+5][r] === 0 && m[c+6][r] === 1;
        if (v && ((c >= 4 && !m[c-1][r] && !m[c-2][r] && !m[c-3][r] && !m[c-4][r]) || (c + 10 < N && !m[c+7][r] && !m[c+8][r] && !m[c+9][r] && !m[c+10][r]))) pen += 40;
      }
      return pen + Math.floor(Math.abs(dark * 100 / (N * N) - 50) / 5) * 10;
    };
    let bestM = null, bestS = 1e9;
    for (let mask = 0; mask < 8; mask++) {
      const m = build(mask), s = score(m);
      if (s < bestS) { bestS = s; bestM = m; }
    }
    const pad = 3, total = N + pad * 2;
    let d = "";
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (bestM[r][c]) d += `M${c+pad},${r+pad}h1v1h-1z`;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Solana Pay QR Code for 3.25 USDC");
    svg.setAttribute("shape-rendering", "crispEdges");
    const bg = document.createElementNS(ns, "rect");
    bg.setAttribute("width", String(total));
    bg.setAttribute("height", String(total));
    bg.setAttribute("fill", "#ffffff");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "#060b16");
    svg.append(bg, path);
    return svg;
  }

  function setStatus(text, tone = "info") {
    const el = find("status");
    el.dataset.tone = tone;
    find("status-text").textContent = text;
    el.hidden = !text;
  }

  function setStep(stage) {
    const s1 = find("step-1"), s2 = find("step-2"), s3 = find("step-3");
    const set = (el, val) => { el.dataset.state = val; };
    if (stage === 1) { set(s1, "active"); set(s2, "pending"); set(s3, "pending"); }
    else if (stage === 2) { set(s1, "done"); set(s2, "active"); set(s3, "pending"); }
    else { set(s1, "done"); set(s2, "done"); set(s3, "done"); }
  }

  function maskKey(val) {
    return val && val.length > 14 ? val.slice(0, 6) + "…" + val.slice(-6) : (val || "—");
  }

  function save() { storage.setItem(key, JSON.stringify(receipt)); }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPoll() {
    if (pollTimer || !receipt.reference) return;
    pollRemaining = 24;
    pollTimer = setInterval(async () => {
      if (document.hidden || !receipt.reference) return;
      if (pollRemaining-- <= 0) {
        stopPoll();
        find("poll-hint").textContent = "Auto-check paused — click Check On-Chain Now anytime.";
        return;
      }
      try { await status(); } catch {}
    }, 10000);
  }

  function renderQr(paymentUrl) {
    const box = find("qr-box");
    if (!paymentUrl || box.dataset.url === paymentUrl) return;
    const svg = makeQrSvg(paymentUrl);
    if (!svg) return;
    box.dataset.url = paymentUrl;
    box.replaceChildren(svg);
  }

  function bindCopy(btnId, getText, label) {
    const btn = find(btnId);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const value = getText();
      if (!value) return;
      const orig = btn.textContent;
      try {
        await navigator.clipboard.writeText(value);
        btn.textContent = label || "Copied ✓";
        setTimeout(() => { btn.textContent = orig; }, 1800);
      } catch {
        setStatus("Clipboard access blocked — please select and copy manually.", "warn");
      }
    });
  }

  function protect(handler) {
    return async event => {
      event?.preventDefault();
      const button = event?.submitter || event?.target?.closest("button");
      if (button) button.disabled = true;
      try { await handler(); }
      catch (error) { setStatus(error.message || "Please try again.", "err"); }
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
    find("boot").hidden = true;
    find("begin").hidden = true;
    find("receipt").hidden = false;
    setStep(2);
    const hash = new URLSearchParams({ order: receipt.reference, access: receipt.access });
    history.replaceState(null, "", location.pathname + location.search + "#" + hash);
    find("ref-val").textContent = maskKey(receipt.reference);
    find("order-email").textContent = receipt.email || "Saved privately with order";
    if (receipt.payment_url) {
      find("pay").href = receipt.payment_url;
      find("pay").hidden = false;
      try {
        const w = new URL(receipt.payment_url).pathname;
        if (w) find("wallet-val").textContent = maskKey(w);
      } catch {}
      renderQr(receipt.payment_url);
    }
  }

  async function status() {
    const result = await api("status", { reference: receipt.reference }, true);
    if (result.state === "paid") {
      stopPoll();
      setStep(3);
      find("pay-zone").hidden = true;
      find("paid-zone").hidden = false;
      find("download").href = result.download;
      find("download").hidden = false;
      find("pay").hidden = true;
      find("confirm").hidden = true;
      const badge = find("state-badge");
      badge.dataset.state = "paid";
      badge.textContent = "Confirmed · Paid";
      find("paid-mail-note").textContent = result.email_accepted
        ? "Receipt & 7-day backup link sent via orders@mail.staai.click."
        : "Your instant download is active below; backup email delivery is queued.";
      setStatus(result.email_accepted
        ? "Payment confirmed. Email accepted for delivery."
        : "Payment confirmed. Your download is ready here.", "ok");
    } else {
      find("paid-zone").hidden = true;
      find("pay-zone").hidden = false;
      find("confirm").hidden = false;
      const badge = find("state-badge");
      badge.dataset.state = "pending";
      badge.textContent = "Awaiting Payment";
      if (result.payment_url) {
        receipt.payment_url = result.payment_url;
        find("pay").href = result.payment_url;
        find("pay").hidden = false;
        try {
          const w = new URL(result.payment_url).pathname;
          if (w) find("wallet-val").textContent = maskKey(w);
        } catch {}
        renderQr(result.payment_url);
      }
      find("poll-hint").textContent = "Listening on Solana Mainnet (checks every 10s)…";
      startPoll();
      setStatus("Waiting for a finalized payment. Pay once using this order’s wallet link or QR.", "warn");
    }
  }

  async function begin() {
    find("boot").hidden = false;
    find("retry-boot").hidden = true;
    try {
      if (receipt.reference) { showOrder(); await status(); return; }
      setStep(1);
      const visit = await api("visit", { id: receipt.id, radar_ref: ref });
      find("offer").textContent = visit.variant === "ci" ?
        "Catch a failed tool call before merging your next release." :
        "Run 24 reusable fault scenarios across five MCP integrations.";
      save();
      find("boot").hidden = true;
      find("begin").hidden = false;
      setStatus("", "info");
    } catch (error) {
      find("boot-msg").textContent = "Could not initialize checkout session.";
      find("retry-boot").hidden = false;
      throw error;
    }
  }

  find("begin").addEventListener("submit", protect(async () => {
    const emailVal = find("email").value.trim();
    const order = await api("checkout", { visit: receipt.id, access: receipt.access, email: emailVal });
    receipt.email = emailVal;
    receipt.reference = order.reference;
    receipt.payment_url = order.payment_url;
    save();
    showOrder();
    await status();
  }));

  find("refresh").addEventListener("click", protect(async () => {
    pollRemaining = 24;
    await status();
  }));

  find("confirm").addEventListener("submit", protect(async () => {
    const sig = find("signature").value.trim();
    const result = await api("confirm", { reference: receipt.reference, signature: sig }, true);
    if (result.state === "pending") {
      setStatus("The transaction has not finalized yet. Check again in a few seconds.", "warn");
    } else {
      await status();
    }
  }));

  find("retry-boot").addEventListener("click", protect(begin));

  find("new-order").addEventListener("click", protect(async () => {
    stopPoll();
    receipt = { id: crypto.randomUUID(), access: crypto.randomUUID() };
    save();
    history.replaceState(null, "", location.pathname + location.search);
    find("receipt").hidden = true;
    find("qr-box").dataset.url = "";
    find("qr-box").replaceChildren();
    find("email").value = "";
    find("signature").value = "";
    await begin();
  }));

  bindCopy("copy-ref", () => receipt.reference, "Copied ✓");
  bindCopy("copy-wallet", () => {
    try { return receipt.payment_url ? new URL(receipt.payment_url).pathname : ""; } catch { return ""; }
  }, "Copied ✓");
  bindCopy("copy-uri", () => receipt.payment_url, "Copied Solana Pay URI ✓");
  bindCopy("copy-receipt", () => location.href, "Copied Receipt Link ✓");

  protect(begin)();
}

function esc(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

export function checkoutPage(amount, opts = {}) {
  const nonce = crypto.randomUUID();
  const wallet = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(opts.wallet || "") ? opts.wallet : "";
  const walletShort = wallet ? wallet.slice(0, 6) + "…" + wallet.slice(-6) : "Merchant USDC Wallet";
  const sender = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.sender || "") ? opts.sender : "orders@mail.staai.click";
  const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.replyTo || "") ? opts.replyTo : sender;
  const solscanHref = wallet ? `https://solscan.io/account/${wallet}` : "";
  const amountLabel = Number(amount).toFixed(2);

  const response = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Checkout · MCP Guard Kit Pro v1.1 (${amountLabel} USDC)</title>
<style nonce="${nonce}">
  :root {
    --bg: #060a13;
    --panel: rgba(15, 23, 42, 0.88);
    --panel-solid: #0f172a;
    --panel-2: #09101f;
    --border: rgba(148, 163, 184, 0.16);
    --border-hi: rgba(56, 189, 248, 0.35);
    --text: #f1f5f9;
    --muted: #94a3b8;
    --soft: #cbd5e1;
    --cyan: #38bdf8;
    --emerald: #10b981;
    --mint: #6ee7b7;
    --amber: #f59e0b;
    --rose: #fb7185;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    font-family: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--text);
    background:
      radial-gradient(ellipse 80% 55% at 20% -10%, rgba(14, 165, 233, 0.16), transparent 60%),
      radial-gradient(ellipse 65% 50% at 95% 100%, rgba(16, 185, 129, 0.12), transparent 60%),
      linear-gradient(rgba(148, 163, 184, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(148, 163, 184, 0.03) 1px, transparent 1px),
      var(--bg);
    background-size: 100% 100%, 100% 100%, 36px 36px, 36px 36px, auto;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; }
  code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
  [hidden] { display: none !important; }
  .shell { max-width: 1040px; margin: 0 auto; padding: 28px 20px 64px; }

  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 14px; flex-wrap: wrap; margin-bottom: 24px;
  }
  .brand {
    display: inline-flex; align-items: center; gap: 10px;
    text-decoration: none; font-weight: 800; letter-spacing: -0.02em; font-size: 17px;
  }
  .brand-mark {
    width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
    background: linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(16, 185, 129, 0.22));
    border: 1px solid rgba(56, 189, 248, 0.35);
    box-shadow: 0 4px 18px rgba(14, 165, 233, 0.16);
  }
  .pro-tag {
    font-size: 11px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 999px;
    background: rgba(16, 185, 129, 0.14); border: 1px solid rgba(16, 185, 129, 0.38); color: var(--mint);
  }
  .top-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .net-pill {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
    background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); color: #a7f3d0;
  }
  .pulse-dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--emerald);
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.25);
  }
  .back-link {
    font-size: 12.5px; font-weight: 600; color: var(--muted); text-decoration: none;
    padding: 6px 11px; border-radius: 9px; border: 1px solid var(--border); background: rgba(15, 23, 42, 0.65);
    transition: border-color .15s, color .15s;
  }
  .back-link:hover { border-color: var(--border-hi); color: var(--text); }

  .stepper {
    display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: center; gap: 10px;
    background: rgba(15, 23, 42, 0.65); border: 1px solid var(--border);
    border-radius: 14px; padding: 12px 18px; margin-bottom: 24px;
    backdrop-filter: blur(10px);
  }
  .step { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .step-num {
    width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
    font-size: 12px; font-weight: 800; border: 1px solid rgba(148, 163, 184, 0.3);
    background: var(--panel-2); color: var(--muted); flex-shrink: 0;
  }
  .step[data-state="active"] { color: var(--text); }
  .step[data-state="active"] .step-num {
    border-color: var(--cyan); color: #03121a; background: var(--cyan);
    box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.18);
  }
  .step[data-state="done"] { color: var(--mint); }
  .step[data-state="done"] .step-num {
    border-color: var(--emerald); color: #03121a; background: var(--emerald);
  }
  .step-line { height: 1px; width: 28px; background: var(--border); }

  .layout { display: grid; grid-template-columns: minmax(0, 1.03fr) minmax(0, 1fr); gap: 22px; align-items: start; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 24px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 24px 60px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(12px);
  }

  .eyebrows { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .eyebrow {
    font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
    padding: 3px 9px; border-radius: 6px; border: 1px solid var(--border); color: var(--soft);
    background: var(--panel-2);
  }
  .eyebrow.cyan { border-color: rgba(56, 189, 248, 0.35); color: #7dd3fc; background: rgba(56, 189, 248, 0.08); }
  h1 { margin: 0 0 10px; font-size: 24px; letter-spacing: -0.02em; line-height: 1.25; }
  .price-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 4px 0 6px; }
  .price-num {
    font-size: 38px; font-weight: 800; letter-spacing: -0.03em; font-variant-numeric: tabular-nums;
    background: linear-gradient(135deg, #ffffff 25%, #6ee7b7 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .price-unit { font-size: 16px; font-weight: 700; color: var(--mint); }
  .price-note { font-size: 12.5px; color: var(--muted); }
  .offer-box {
    margin: 14px 0 18px; padding: 11px 14px; border-radius: 10px;
    border-left: 3px solid var(--cyan); background: rgba(56, 189, 248, 0.07);
    font-size: 13.5px; color: #e0f2fe; font-weight: 500;
  }
  .stats-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 18px; }
  .stat-tile {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 12px; padding: 11px 13px;
  }
  .stat-val { font-size: 17px; font-weight: 800; color: var(--mint); font-variant-numeric: tabular-nums; }
  .stat-lbl { font-size: 11.5px; color: var(--muted); margin-top: 2px; }

  .sec-title {
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--muted); margin: 0 0 10px;
  }
  .feat-list { list-style: none; margin: 0 0 18px; padding: 0; display: grid; gap: 10px; }
  .feat-list li { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: var(--soft); }
  .feat-ic { width: 18px; height: 18px; flex-shrink: 0; margin-top: 2px; color: var(--emerald); }
  .feat-list b { color: var(--text); }

  .trust-foot {
    border-top: 1px solid var(--border); padding-top: 14px;
    display: grid; gap: 7px; font-size: 12px; color: var(--muted);
  }
  .trust-line { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .trust-line code { color: #a7f3d0; font-size: 11.5px; }
  .trust-link { color: #7dd3fc; text-decoration: none; font-weight: 600; }
  .trust-link:hover { text-decoration: underline; }

  .console-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  h2 { margin: 0; font-size: 19px; letter-spacing: -0.015em; }
  .console-sub { margin: 0 0 16px; font-size: 13.5px; color: var(--muted); }
  .field-lbl { display: block; font-size: 12.5px; font-weight: 600; color: var(--soft); margin-bottom: 7px; }
  .input-box {
    width: 100%; padding: 12px 14px; border-radius: 10px;
    border: 1px solid #283652; background: #070d1a; color: var(--text);
    font: inherit; font-size: 14px; outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  .input-box:focus { border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.16); }
  .input-mono { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 12.5px; }
  .field-hint { font-size: 12px; color: var(--muted); margin: 7px 0 16px; }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    font: inherit; font-weight: 700; font-size: 14px; text-decoration: none;
    padding: 12px 16px; border-radius: 11px; border: 1px solid transparent;
    cursor: pointer; transition: transform .12s, box-shadow .15s, border-color .15s, opacity .15s;
  }
  .btn:hover:not(:disabled) { transform: translateY(-1px); }
  .btn:disabled { opacity: 0.55; cursor: wait; }
  .btn-primary {
    width: 100%;
    background: linear-gradient(135deg, #10b981 0%, #06b6d4 100%);
    color: #03121a;
    box-shadow: 0 10px 26px rgba(16, 185, 129, 0.26);
  }
  .btn-primary:hover:not(:disabled) { box-shadow: 0 12px 30px rgba(6, 182, 212, 0.34); }
  .btn-secondary {
    background: #172136; color: var(--text); border-color: #2c3b59; font-size: 13px; padding: 10px 13px;
  }
  .btn-secondary:hover:not(:disabled) { border-color: var(--cyan); }
  .btn-full { width: 100%; }
  .btn-outline {
    background: transparent; color: #7dd3fc; border-color: rgba(56, 189, 248, 0.4);
    font-size: 13px; padding: 10px 14px; white-space: nowrap;
  }
  .btn-outline:hover:not(:disabled) { background: rgba(56, 189, 248, 0.1); }
  .btn-hero { padding: 14px 18px; font-size: 15px; margin: 12px 0; }

  .micro-trust {
    display: flex; align-items: center; gap: 8px; margin-top: 14px; padding-top: 12px;
    border-top: 1px dashed var(--border); font-size: 12px; color: var(--muted);
  }
  .micro-trust svg { width: 15px; height: 15px; color: var(--cyan); flex-shrink: 0; }

  .state-badge {
    font-size: 11.5px; font-weight: 700; padding: 4px 10px; border-radius: 999px;
    background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); color: #fcd34d;
  }
  .state-badge[data-state="paid"] {
    background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.45); color: var(--mint);
  }
  .receipt-tip {
    font-size: 12.5px; color: var(--muted); margin: 0 0 14px;
    padding: 9px 12px; border-radius: 9px; background: var(--panel-2); border: 1px solid var(--border);
  }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-bottom: 16px; }
  .meta-item {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px;
  }
  .meta-k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .meta-v {
    margin-top: 3px; font-size: 12.5px; font-weight: 600; color: var(--text);
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    overflow-wrap: anywhere;
  }
  .copy-mini {
    border: 1px solid #2b3b5a; background: #141e33; color: #bae6fd;
    font: inherit; font-size: 11px; font-weight: 700; border-radius: 6px; padding: 2px 7px; cursor: pointer;
    flex-shrink: 0;
  }
  .copy-mini:hover { border-color: var(--cyan); }

  .qr-panel {
    display: grid; grid-template-columns: 166px 1fr; gap: 16px; align-items: center;
    padding: 14px; border-radius: 14px; background: var(--panel-2);
    border: 1px solid rgba(56, 189, 248, 0.25); margin-bottom: 14px;
  }
  .qr-frame {
    width: 166px; height: 166px; border-radius: 12px; background: #ffffff; padding: 7px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45); display: grid; place-items: center;
  }
  .qr-frame svg { width: 100%; height: 100%; display: block; }
  .qr-title { font-size: 14px; font-weight: 700; color: var(--text); margin: 0 0 5px; }
  .qr-desc { font-size: 12.5px; color: var(--muted); margin: 0 0 10px; }
  .poll-pill {
    display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600;
    color: #7dd3fc; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.24);
    border-radius: 8px; padding: 5px 9px;
  }
  .action-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 9px; }

  .confirm-box {
    margin-top: 15px; padding: 13px; border-radius: 12px;
    background: var(--panel-2); border: 1px dashed #2d3d5e;
  }
  .confirm-row { display: flex; gap: 8px; margin-top: 8px; }
  .confirm-row .input-box { padding: 9px 11px; }

  .paid-card {
    padding: 16px; border-radius: 14px;
    background: linear-gradient(155deg, rgba(16, 185, 129, 0.14), rgba(6, 182, 212, 0.08));
    border: 1px solid rgba(16, 185, 129, 0.45);
  }
  .paid-head { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 800; color: var(--mint); }
  .paid-head svg { width: 22px; height: 22px; flex-shrink: 0; }
  .paid-sub { margin: 6px 0 4px; font-size: 13px; color: var(--soft); }
  .paid-note { font-size: 11.5px; color: var(--muted); margin-top: 8px; text-align: center; }

  .receipt-foot {
    margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12px; color: var(--muted);
  }
  .link-btn {
    background: none; border: none; padding: 0; font: inherit; font-weight: 600;
    color: var(--muted); cursor: pointer; text-decoration: underline;
  }
  .link-btn:hover { color: var(--text); }

  .boot-box {
    padding: 28px 12px; text-align: center; color: var(--muted); font-size: 13.5px;
    display: grid; gap: 12px; justify-items: center;
  }
  .status-bar {
    margin-top: 14px; padding: 10px 13px; border-radius: 10px; font-size: 12.5px; font-weight: 500;
    display: flex; align-items: center; gap: 9px; border: 1px solid var(--border); background: var(--panel-2); color: var(--soft);
  }
  .status-bar .s-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--cyan); }
  .status-bar[data-tone="warn"] { border-color: rgba(245, 158, 11, 0.35); background: rgba(245, 158, 11, 0.08); color: #fde68a; }
  .status-bar[data-tone="warn"] .s-dot { background: var(--amber); }
  .status-bar[data-tone="ok"] { border-color: rgba(16, 185, 129, 0.42); background: rgba(16, 185, 129, 0.1); color: #a7f3d0; }
  .status-bar[data-tone="ok"] .s-dot { background: var(--emerald); }
  .status-bar[data-tone="err"] { border-color: rgba(251, 113, 133, 0.42); background: rgba(251, 113, 133, 0.09); color: #fecdd3; }
  .status-bar[data-tone="err"] .s-dot { background: var(--rose); }

  @media (max-width: 860px) {
    .layout { grid-template-columns: 1fr; }
    .stepper { grid-template-columns: 1fr; gap: 8px; }
    .step-line { display: none; }
  }
  @media (max-width: 520px) {
    .qr-panel { grid-template-columns: 1fr; justify-items: center; text-align: center; }
    .meta-grid, .action-row-2, .stats-row { grid-template-columns: 1fr; }
    .confirm-row { flex-direction: column; }
  }
</style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="https://thongtuehuu-cyber.github.io/mcp-guard-kit/" rel="noopener noreferrer">
        <span class="brand-mark" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6ee7b7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="m9 12 2 2 4-4" stroke="#38bdf8"/>
          </svg>
        </span>
        <span>MCP Guard Kit</span>
        <span class="pro-tag">Pro v1.1</span>
      </a>
      <div class="top-right">
        <span class="net-pill"><span class="pulse-dot" aria-hidden="true"></span>Solana Mainnet · 24/7 Auto-Delivery</span>
        <a class="back-link" href="https://thongtuehuu-cyber.github.io/mcp-guard-kit/" rel="noopener noreferrer">← Product Overview</a>
      </div>
    </header>

    <nav class="stepper" aria-label="Checkout progress">
      <div class="step" id="step-1" data-state="active"><span class="step-num">1</span><span>Order &amp; Receipt Email</span></div>
      <div class="step-line" aria-hidden="true"></div>
      <div class="step" id="step-2" data-state="pending"><span class="step-num">2</span><span>Pay ${amountLabel} USDC</span></div>
      <div class="step-line" aria-hidden="true"></div>
      <div class="step" id="step-3" data-state="pending"><span class="step-num">3</span><span>Instant ZIP + Email</span></div>
    </nav>

    <div class="layout">
      <aside class="card">
        <div class="eyebrows">
          <span class="eyebrow cyan">One-Time License</span>
          <span class="eyebrow">Instant Digital Download</span>
        </div>
        <h1>MCP Guard Kit Pro v1.1</h1>
        <div class="price-row">
          <span class="price-num">${amountLabel}</span>
          <span class="price-unit">USDC</span>
          <span class="price-note">· Solana SPL · 0% markup</span>
        </div>
        <div class="offer-box" id="offer">One-time purchase on Solana mainnet.</div>

        <div class="stats-row">
          <div class="stat-tile">
            <div class="stat-val">96 / 96 Caught</div>
            <div class="stat-lbl">120-trial fault benchmark (0 false alarms)</div>
          </div>
          <div class="stat-tile">
            <div class="stat-val">20 Files · 43.9 KB</div>
            <div class="stat-lbl">Pure Python ≥ 3.10 · zero deps</div>
          </div>
        </div>

        <div class="sec-title">What’s inside your release ZIP</div>
        <ul class="feat-list">
          <li>
            <svg class="feat-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            <span><b>24 production fault scenarios</b> across Stripe, GitHub, Postgres, Slack &amp; Playwright JSON-RPC envelopes</span>
          </li>
          <li>
            <svg class="feat-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            <span><b>Live chaos proxies:</b> <code>proxy-stdio</code> (NDJSON / Content-Length) and <code>proxy-http</code> reverse proxy</span>
          </li>
          <li>
            <svg class="feat-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            <span><b>Native Pytest plugin:</b> <code>mcp_chaos</code>, <code>mcp_assert_honest</code> &amp; deterministic seed flags</span>
          </li>
          <li>
            <svg class="feat-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            <span><b>CI PR gate exports:</b> SARIF 2.1, JUnit XML, GitHub Actions workflow &amp; Executive HTML report</span>
          </li>
          <li>
            <svg class="feat-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            <span><b>Perpetual commercial license</b> for unlimited internal, client &amp; CI/CD repositories</span>
          </li>
        </ul>

        <div class="trust-foot">
          <div class="trust-line"><span>Fulfillment mailer</span><code>${esc(sender)}</code></div>
          <div class="trust-line"><span>Support reply-to</span><code>${esc(replyTo)}</code></div>
          <div class="trust-line">
            <span>Merchant wallet</span>
            <span>
              <code>${esc(walletShort)}</code>
              ${solscanHref ? ` · <a class="trust-link" href="${solscanHref}" target="_blank" rel="noopener noreferrer">Solscan ↗</a>` : ""}
            </span>
          </div>
          <div class="trust-line"><span>Download signing</span><code>HMAC-SHA256 · 7-day renewable</code></div>
        </div>
      </aside>

      <main class="card">
        <div id="boot" class="boot-box">
          <div id="boot-msg">Initializing encrypted Solana Pay session…</div>
          <button type="button" id="retry-boot" class="btn btn-outline" hidden>Retry session</button>
        </div>

        <form id="begin" hidden>
          <div class="console-head">
            <h2>Start Your Order</h2>
          </div>
          <p class="console-sub">Lock a unique per-order Solana Pay reference and generate your scannable QR code &amp; private receipt.</p>
          <label class="field-lbl" for="email">Delivery &amp; receipt email</label>
          <input id="email" class="input-box" type="email" autocomplete="email" maxlength="254" placeholder="you@company.com" required>
          <p class="field-hint">Your 7-day signed download link will unlock immediately on-page after finality and be emailed from <code>${esc(sender)}</code>.</p>
          <button type="submit" id="create-btn" class="btn btn-primary">
            Generate ${amountLabel} USDC Payment Link →
          </button>
          <div class="micro-trust">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <span>Finalized on-chain SPL verification · Bookmarkable recovery receipt · 5-min auto-reconcile fallback.</span>
          </div>
        </form>

        <section id="receipt" hidden>
          <div class="console-head">
            <h2>Private Order Receipt</h2>
            <span class="state-badge" id="state-badge" data-state="pending">Awaiting Payment</span>
          </div>
          <p class="receipt-tip">Bookmark this page URL privately to reopen your order or issue a fresh 7-day download link anytime. Anyone with the URL fragment can access this receipt.</p>

          <div class="meta-grid">
            <div class="meta-item">
              <div class="meta-k">Exact Amount</div>
              <div class="meta-v"><span>${amountLabel} USDC</span><span class="eyebrow">SPL</span></div>
            </div>
            <div class="meta-item">
              <div class="meta-k">Delivery Email</div>
              <div class="meta-v"><span id="order-email">Saved privately</span></div>
            </div>
            <div class="meta-item">
              <div class="meta-k">Order Reference</div>
              <div class="meta-v"><code id="ref-val">—</code><button type="button" class="copy-mini" id="copy-ref">Copy</button></div>
            </div>
            <div class="meta-item">
              <div class="meta-k">Recipient Wallet</div>
              <div class="meta-v"><code id="wallet-val">${esc(walletShort)}</code><button type="button" class="copy-mini" id="copy-wallet">Copy</button></div>
            </div>
          </div>

          <div id="pay-zone">
            <div class="qr-panel">
              <div class="qr-frame" id="qr-box" aria-label="Solana Pay QR Code"></div>
              <div>
                <div class="qr-title">Scan or tap wallet to pay</div>
                <p class="qr-desc">Embeds exact <b>${amountLabel} USDC</b> SPL transfer &amp; unique order reference for Phantom, Solflare, or Backpack.</p>
                <div class="poll-pill" id="poll-hint">Listening on Solana Mainnet (checks every 10s)…</div>
              </div>
            </div>

            <a class="btn btn-primary" id="pay" hidden>Pay ${amountLabel} USDC in Solana Wallet ↗</a>
            <div class="action-row-2">
              <button type="button" class="btn btn-secondary" id="copy-uri">Copy Solana Pay URI</button>
              <button type="button" class="btn btn-secondary" id="refresh">Check On-Chain Now</button>
            </div>

            <form id="confirm" class="confirm-box">
              <label class="field-lbl" for="signature">Already approved the Solana Pay transaction? Verify Tx signature directly:</label>
              <div class="confirm-row">
                <input id="signature" class="input-box input-mono" maxlength="100" placeholder="Paste base58 Tx signature..." required>
                <button type="submit" class="btn btn-outline">Verify Tx</button>
              </div>
            </form>
          </div>

          <div id="paid-zone" class="paid-card" hidden>
            <div class="paid-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>
              <span>Payment Confirmed on Solana Mainnet</span>
            </div>
            <p class="paid-sub" id="paid-mail-note">Your Pro v1.1 archive is unlocked and ready.</p>
            <a class="btn btn-primary btn-hero" id="download" hidden>Download mcp-guard-kit-pro-v1.1.zip (43.9 KB) ↓</a>
            <button type="button" class="btn btn-secondary btn-full" id="copy-receipt">Copy Private Receipt Link</button>
            <p class="paid-note">Signed URL expires in 7 days — reopen your bookmarked receipt anytime to issue a fresh download link.</p>
          </div>

          <div class="receipt-foot">
            <span>Verified USDC Mainnet SPL checkout</span>
            <button type="button" class="link-btn" id="new-order">Start another order</button>
          </div>
        </section>

        <div class="status-bar" role="status" aria-live="polite" id="status" data-tone="info" hidden>
          <span class="s-dot" aria-hidden="true"></span>
          <span id="status-text"></span>
        </div>
      </main>
    </div>
  </div>
  <script nonce="${nonce}">(${buyerCheckout.toString()})();</script>
</body>
</html>`;

  return new Response(response, { headers: {
    "content-type": "text/html;charset=UTF-8",
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  } });
}
