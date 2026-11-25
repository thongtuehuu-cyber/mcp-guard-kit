import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../worker.js";
import { isOrderTransfer, newReference, USDC } from "../payments.mjs";
import { retryDue } from "../delivery.mjs";

// Cloudflare extends SubtleCrypto with this constant-time comparison.
if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const wallet = "GPrbk8Lj3ZBCM26TzE3Zv1Dg9z2pJwMaZuc7sA5qCEXF";
const program = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const origin = "https://checkout.example";
const signature = "1".repeat(64);

function encode(bytes) {
  let digits = "";
  let value = bytes.reduce((v, b) => (v << 8n) + BigInt(b), 0n);
  while (value) {
    digits = alphabet[Number(value % 58n)] + digits;
    value /= 58n;
  }
  return digits;
}

function transaction(reference, amount = 3250000) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = 6;
  const post = { accountIndex: 2, mint: USDC, owner: wallet,
    uiTokenAmount: { amount: String(amount), decimals: 6 } };
  return { blockTime: Math.floor(Date.now() / 1000), meta: { err: null, preTokenBalances: [], postTokenBalances: [post] },
    transaction: { signatures: [signature], message: {
      accountKeys: ["source", USDC, "destination", "owner", reference, program],
      instructions: [{ programIdIndex: 5, accounts: [0, 1, 2, 3, 4], data: encode(data) }]
    } } };
}

// D1 has SQLite semantics. Only the binding envelope is adapted here.
function binding() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of ["0001_commerce.sql", "0002_offer_policy.sql", "0003_pending_payments.sql", "0004_product_sku.sql", "0005_x402.sql", "0006_x402_bounty_feed.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
  function prepare(sql, args = []) {
    const statement = sqlite.prepare(sql);
    return {
      bind: (...params) => prepare(sql, params),
      first: async () => statement.get(...args) || null,
      all: async () => ({ results: statement.all(...args) }),
      run: async () => ({ meta: statement.run(...args) })
    };
  }
  async function batch(statements) {
    sqlite.exec("BEGIN");
    try {
      for (const statement of statements) await statement.run();
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }
  return { prepare, sqlite, batch };
}

function setup(t) {
  const db = binding();
  t.after(() => db.sqlite.close());
  const pending = [];
  const ctx = { waitUntil: promise => pending.push(promise) };
  const blobs = {
    "mcp-guard-kit-pro-v1.1.zip": new Uint8Array([80, 75]),
    "mcp-guard-kit-pro-v1.2.zip": new Uint8Array([80, 75, 1, 2]),
    "deal-monitor-self-hosted-v1.2.zip": new Uint8Array([80, 75, 3, 4]),
  };
  const env = { PUBLIC_ORIGIN: origin, COMMERCE_DB: db, MERCHANT_WALLET: wallet, HMAC_SECRET: "test-only",
    COMMERCE_FEED_TOKEN: "local-feed", HELIUS_AUTH_SECRET: "test-webhook", BREVO_API_KEY: "local-mail",
    SENDER_EMAIL: "orders@mail.staai.click", REPLY_TO_EMAIL: "orders@mail.staai.click",
    PRO_FILES: { get: async key => (blobs[key] ? { body: blobs[key] } : null) } };
  const call = (path, body, auth) => worker.fetch(new Request(origin + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: body && JSON.stringify(body)
  }), env, ctx);
  return { env, db, call, flush: async () => { while (pending.length) await pending.shift(); } };
}

test("checkout, finalized transfer, email retry, private recovery, repeat use and replay", async t => {
  const { env, db, call, flush } = setup(t);
  const localFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = localFetch; });
  const id = crypto.randomUUID();
  const access = crypto.randomUUID();
  const bearer = "Bearer " + access;
  const tag = "a".repeat(24) + "_1";
  const view = { id, radar_ref: tag };
  assert.equal((await call("/checkout")).status, 200);
  const variant = (await (await call("/api/visit", view)).json()).variant;
  assert.equal((await (await call("/api/visit", view)).json()).variant, variant);
  const payload = { visit: id, access, email: "buyer@example.invalid" };
  const order = await (await call("/api/checkout", payload)).json();
  const { reference } = order;
  assert.equal(new URL(order.payment_url).searchParams.get("reference"), reference);
  assert.equal((await (await call("/api/checkout", payload)).json()).reference, reference);
  assert.equal((await call("/api/status", { reference }, "Bearer " + crypto.randomUUID())).status, 403);
  let rpc = null;
  let accepted = false;
  let emails = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("brevo")) {
      emails++;
      assert.equal(JSON.parse(init.body).headers.idempotencyKey, reference);
      return accepted ? Response.json({ messageId: "accepted" }) : new Response("down", { status: 503 });
    }
    assert.equal(JSON.parse(init.body).params[1].commitment, "finalized");
    return Response.json({ result: rpc });
  };
  assert.equal((await call("/api/confirm", { reference, signature }, bearer)).status, 202);
  rpc = transaction(reference, 10000);
  assert.equal((await call("/api/confirm", { reference, signature }, bearer)).status, 422);
  rpc = transaction(reference);
  const hook = [{ signature, instructions: [{ accounts: [reference] }], tokenTransfers: [{ toUserAccount: wallet }] }];
  assert.equal((await call("/api/helius-webhook", hook, "wrong")).status, 401);
  const responses = await Promise.all([
    call("/api/helius-webhook", hook, "test-webhook"), call("/api/confirm", { reference, signature }, bearer)
  ]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  await flush();
  const row = () => db.sqlite.prepare("select * from orders where reference=?").get(reference);
  assert.equal(emails, 1);
  assert.equal(row().mail_id, null);
  assert.ok(row().next_try > Date.now());
  const receipt = await (await call("/api/status", { reference }, bearer)).json();
  assert.equal(receipt.state, "paid");
  const url = new URL(receipt.download);
  assert.equal((await call("/download?sig=" + signature + "&token=bad")).status, 403);
  const file = await call(url.pathname + url.search);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([80, 75]));
  await call(url.pathname + url.search);
  accepted = true;
  db.sqlite.prepare("update orders set next_try=0").run();
  await Promise.all([retryDue(env), retryDue(env)]);
  assert.equal(emails, 2);
  assert.equal(row().mail_id, "accepted");
  await call("/api/helius-webhook", hook, "test-webhook");
  await flush();
  assert.equal(emails, 2);
  for (const release of ["r1", "r1", "r2"]) {
    assert.equal((await call("/api/usage", { reference, release }, bearer)).status, 200);
  }
  assert.equal((await call("/api/funnel/events")).status, 401);
  const { events } = await (await call("/api/funnel/events", null, "Bearer local-feed")).json();
  assert.deepEqual(events.map(e => e.stage), ["viewed", "checkout", "paid", "download_started", "email_accepted",
    "release_used", "release_used"]);
  assert.equal(events[2].amount_cents, 325);
  assert.ok(events.every(e => e.radar_ref === tag && e.variant === variant));
  assert.ok(!JSON.stringify(events).includes(payload.email));
  assert.equal((await (await call("/api/funnel/events?after=" + events.at(-1).id, null,
    "Bearer local-feed")).json()).events.length, 0);
});

test("only the exact recipient, mint, instruction reference, time and amount match an order", () => {
  const order = { reference: newReference(), expected_micros: 3250000, created_at: Date.now() };
  for (const mutate of [
    tx => { tx.meta.err = { error: true }; },
    tx => { tx.blockTime -= 300; },
    tx => { tx.meta.postTokenBalances[0].owner = "someone else"; },
    tx => { tx.meta.postTokenBalances[0].mint = "another mint"; },
    tx => { tx.transaction.message.instructions[0].accounts.pop(); },
    tx => { tx.transaction.message.instructions[0].programIdIndex = 1; },
    tx => { tx.meta.preTokenBalances = structuredClone(tx.meta.postTokenBalances); }
  ]) {
    const tx = transaction(order.reference);
    mutate(tx);
    assert.equal(isOrderTransfer(tx, signature, order, wallet), false);
  }
});

test("legacy order creation remains idempotent and cannot replace a buyer email", async t => {
  const { call } = setup(t);
  const data = { reference_pubkey: newReference(), email: "old@example.invalid" };
  assert.equal((await call("/api/checkout", data)).status, 200);
  assert.equal((await call("/api/checkout", data)).status, 200);
  assert.equal((await call("/api/checkout", { ...data, email: "other@example.invalid" })).status, 409);
});

test("separate policy capability preserves existing visit assignments and expires old rules", async t => {
  const { env, db, call } = setup(t);
  env.COMMERCE_POLICY_TOKEN = "policy-only";
  const id = crypto.randomUUID();
  const tag = "a".repeat(24) + "_1";
  const visit = { id, radar_ref: tag };
  const old = await (await call("/api/visit", visit)).json();
  const body = { policies: [{ radar_ref: tag, winner: "ci" }] };
  assert.equal((await call("/api/funnel/policy", body, "Bearer local-feed")).status, 401);
  assert.equal((await call("/api/funnel/policy", body, "Bearer policy-only")).status, 200);
  assert.equal((await (await call("/api/visit", visit)).json()).variant, old.variant);
  const before = db.sqlite.prepare("SELECT exploration FROM visits WHERE id=?").get(id);
  assert.equal(before.exploration, 1);
  db.sqlite.exec("UPDATE offer_policy SET expires_at=0");
  const fresh = crypto.randomUUID();
  await call("/api/visit", { id: fresh, radar_ref: tag });
  assert.equal(db.sqlite.prepare("SELECT exploration FROM visits WHERE id=?").get(fresh).exploration, 1);
});

test("cron discovers a finalized transfer with a closed browser and no webhook", async t => {
  const { env, db, call, flush } = setup(t);
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  const visit = crypto.randomUUID();
  await call("/api/visit", { id: visit, radar_ref: "" });
  const receipt = await (await call("/api/checkout", {
    visit, access: crypto.randomUUID(), email: "offline@example.invalid"
  })).json();
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("brevo")) return Response.json({ messageId: "cron-mail" });
    const { method, params } = JSON.parse(init.body);
    if (method === "getSignaturesForAddress") {
      assert.equal(params[0], receipt.reference);
      return Response.json({ result: [{ signature, err: null }] });
    }
    return Response.json({ result: transaction(receipt.reference) });
  };
  const pending = [];
  worker.scheduled({}, env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  await flush();
  const saved = db.sqlite.prepare("SELECT * FROM orders WHERE reference=?").get(receipt.reference);
  assert.equal(saved.signature, signature);
  assert.equal(saved.mail_id, "cron-mail");
});

test("checkout auto-backfills missing visit row instead of failing with Unknown visit", async t => {
  const { db, call } = setup(t);
  const directVisit = crypto.randomUUID();
  const access = crypto.randomUUID();
  const res = await call("/api/checkout", {
    visit: directVisit,
    access,
    email: "direct@example.invalid",
  });
  assert.equal(res.status, 200);
  const order = await res.json();
  assert.equal(order.amount, 3.25);
  assert.ok(order.payment_url.includes("reference=" + order.reference));
  const vrow = db.sqlite.prepare("SELECT * FROM visits WHERE id=?").get(directVisit);
  assert.ok(vrow && vrow.variant === "control");

  const page = await call("/checkout");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("data-lang-btn=\"vi\""));
  assert.ok(html.includes("manual-drawer"));
});

test("multi-SKU checkout enforces exact USDC amounts and delivers SKU-matched artifacts", async t => {
  const { call, flush } = setup(t);
  const localFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = localFetch; });

  assert.equal((await call("/api/checkout", {
    visit: crypto.randomUUID(), access: crypto.randomUUID(), email: "a@b.invalid", sku: "bogus"
  })).status, 400);

  const cases = [
    { sku: "team", micros: 79000000, filename: "mcp-guard-kit-pro-v1.2.zip", bytes: [80, 75, 1, 2], sig: "1".repeat(63) + "2" },
    { sku: "deal-monitor", micros: 19000000, filename: "deal-monitor-self-hosted-v1.2.zip", bytes: [80, 75, 3, 4], sig: "1".repeat(63) + "3" },
  ];

  for (const item of cases) {
    const visit = crypto.randomUUID();
    const access = crypto.randomUUID();
    const bearer = "Bearer " + access;
    const res = await call("/api/checkout", { visit, access, email: "buyer@corp.invalid", sku: item.sku });
    assert.equal(res.status, 200);
    const order = await res.json();
    assert.equal(order.sku, item.sku);
    assert.equal(order.amount, item.micros / 1000000);

    const txWrong = transaction(order.reference, 3250000);
    txWrong.transaction.signatures[0] = item.sig;
    const txRight = transaction(order.reference, item.micros);
    txRight.transaction.signatures[0] = item.sig;

    let activeTx = txWrong;
    globalThis.fetch = async url => {
      if (String(url).includes("brevo")) return Response.json({ messageId: "ok-" + item.sku });
      return Response.json({ result: activeTx });
    };

    assert.equal((await call("/api/confirm", { reference: order.reference, signature: item.sig }, bearer)).status, 422);
    activeTx = txRight;
    assert.equal((await call("/api/confirm", { reference: order.reference, signature: item.sig }, bearer)).status, 200);
    await flush();

    const status = await (await call("/api/status", { reference: order.reference }, bearer)).json();
    assert.equal(status.state, "paid");
    assert.equal(status.sku, item.sku);
    assert.equal(status.filename, item.filename);

    const dlUrl = new URL(status.download);
    const dlResp = await call(dlUrl.pathname + dlUrl.search);
    assert.equal(dlResp.status, 200);
    assert.ok((dlResp.headers.get("content-disposition") || "").includes(item.filename));
    assert.deepEqual(Array.from(new Uint8Array(await dlResp.arrayBuffer())), item.bytes);
  }

  const dmPage = await (await call("/checkout?sku=deal-monitor")).text();
  assert.ok(dmPage.includes("data-sku=\"deal-monitor\""));
  assert.ok(dmPage.includes("orders@mail.staai.click"));
  assert.ok(!dmPage.includes("gmail.com"));
});

test("DEFAULT_SKU=solo resolves /checkout default order to 19 USDC Pro v1.2", async t => {
  const { env, call } = setup(t);
  env.DEFAULT_SKU = "solo";
  const page = await (await call("/checkout")).text();
  assert.ok(page.includes('data-sku="solo"'));
  assert.ok(page.includes("Benchmark 96/96 lỗi"));
  const res = await call("/api/checkout", {
    visit: crypto.randomUUID(),
    access: crypto.randomUUID(),
    email: "solo@example.invalid",
  });
  assert.equal(res.status, 200);
  const order = await res.json();
  assert.equal(order.sku, "solo");
  assert.equal(order.amount, 19);
});

test("x402 pay-per-call gateway enforces 402, settles 0.05 USDC, rejects 409 replay mismatch, and blocks SSRF", async t => {
  const { env, call } = setup(t);
  const localFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = localFetch; });

  // 1. Discovery manifest
  const discRes = await call("/.well-known/x402.json");
  assert.equal(discRes.status, 200);
  assert.equal(discRes.headers.get("access-control-allow-origin"), "*");
  const disc = await discRes.json();
  assert.equal(disc.x402Version, 1);
  assert.equal(disc.endpoints.length, 7);

  // 2. Unpaid call returns HTTP 402 + PAYMENT-REQUIRED header
  const auditBody = {
    traces: [
      {
        case_id: "c1",
        tool_name: "charge",
        fault_id: "silent_error_200",
        tool_response: { status_code: 200, body: { paid: false, error: "card_declined" } },
        agent_claim: "Payment completed successfully!",
        required_keys: ["charge_id"],
      },
    ],
  };
  const unpaid = await call("/api/v1/x402/mcp-audit", auditBody);
  assert.equal(unpaid.status, 402);
  const prHdr = JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(prHdr.accepts[0].maxAmountRequired, "50000");
  assert.equal(prHdr.accepts[0].payTo, wallet);

  // 3. Paid call with finalized 0.05 USDC SPL transfer
  const xSig = "1".repeat(63) + "7";
  const xRef = prHdr.accepts[0].extra.reference;
  const tx5 = transaction(xRef, 50000);
  tx5.transaction.signatures[0] = xSig;
  globalThis.fetch = async () => Response.json({ result: tx5 });

  const postPaid = (path, payload, payHdr) => worker.fetch(new Request(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payHdr },
    body: JSON.stringify(payload),
  }), env, { waitUntil() {} });

  const payHeader = JSON.stringify({ signature: xSig, reference: xRef });
  const paidRes = await postPaid("/api/v1/x402/mcp-audit", auditBody, payHeader);
  assert.equal(paidRes.status, 200);
  const auditJson = await paidRes.json();
  assert.equal(auditJson.hallucinations, 1);
  assert.equal(auditJson.results[0].verdict, "FAIL_HALLUCINATION");
  const prMeta = JSON.parse(Buffer.from(paidRes.headers.get("x-payment-response"), "base64").toString("utf8"));
  assert.equal(prMeta.settled, true);
  assert.equal(prMeta.replayed, false);

  // 4. Idempotent replay with same body returns 200 replayed=true; different body returns 409
  const replayRes = await postPaid("/api/v1/x402/mcp-audit", auditBody, payHeader);
  assert.equal(replayRes.status, 200);
  assert.equal(JSON.parse(Buffer.from(replayRes.headers.get("x-payment-response"), "base64").toString("utf8")).replayed, true);
  const mismatchRes = await postPaid("/api/v1/x402/mcp-audit", {
    traces: [{ ...auditBody.traces[0], case_id: "c2" }],
  }, payHeader);
  assert.equal(mismatchRes.status, 409);

  // 5. Paid x402 event emitted once to telemetry feed (viewed from trigger + paid)
  const { events } = await (await call("/api/funnel/events", null, "Bearer local-feed")).json();
  assert.deepEqual(events.map(e => e.stage), ["viewed", "paid"]);
  assert.equal(events[1].amount_cents, 5);

  // 6. price-extract rejects SSRF / http before consuming signature, and extracts JSON-LD + Shopify
  const ssrfRes = await postPaid("/api/v1/x402/price-extract", {
    adapter: "jsonld", currency: "USD", url: "https://169.254.169.254/latest/meta-data",
  }, JSON.stringify({ signature: "1".repeat(63) + "8" }));
  assert.equal(ssrfRes.status, 400);

  const pSig = "1".repeat(63) + "9";
  const pRef = newReference();
  const txPrice = transaction(pRef, 50000);
  txPrice.transaction.signatures[0] = pSig;
  globalThis.fetch = async () => Response.json({ result: txPrice });
  const priceRes = await postPaid("/api/v1/x402/price-extract", {
    adapter: "jsonld",
    currency: "USD",
    html: '<script type="application/ld+json">{"@type":"Product","name":"Pro","offers":{"@type":"AggregateOffer","lowPrice":"19.00","priceCurrency":"USD"}}</script>',
  }, JSON.stringify({ signature: pSig, reference: pRef }));
  assert.equal(priceRes.status, 200);
  const priceData = await priceRes.json();
  assert.equal(priceData.price_cents, 1900);
  assert.equal(priceData.price, 19);
});

test("x402 v2 endpoints: pr-critic (0.15 USDC), blind-judge (0.10 USDC), and bounty-feed (0.05 USDC)", async t => {
  const { env, call } = setup(t);
  env.COMMERCE_POLICY_TOKEN = "local-policy";
  const localFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = localFetch; });

  const postPaid = (path, payload, payHdr) => worker.fetch(new Request(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payHdr },
    body: JSON.stringify(payload),
  }), env, { waitUntil() {} });

  // 1. PR Critic (0.15 USDC = 150000 micros) catches .env + trivial assert True
  const unpCritic = await call("/api/v1/x402/pr-critic", { diff: "diff --git a/a.py b/a.py\n+x=1" });
  assert.equal(unpCritic.status, 402);
  const criticHdr = JSON.parse(Buffer.from(unpCritic.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(criticHdr.accepts[0].maxAmountRequired, "150000");

  const sigC = "1".repeat(63) + "a";
  const refC = criticHdr.accepts[0].extra.reference;
  const txC = transaction(refC, 150000);
  txC.transaction.signatures[0] = sigC;
  globalThis.fetch = async () => Response.json({ result: txC });

  const badDiffRes = await postPaid("/api/v1/x402/pr-critic", {
    diff: "diff --git a/.env b/.env\n+++ b/.env\n+TOKEN=1\ndiff --git a/test_a.py b/test_a.py\n+++ b/test_a.py\n+def test_x():\n+    assert True\n",
    test_output: "1 FAILED in 0.1s",
    claimed_pass: true,
  }, JSON.stringify({ signature: sigC, reference: refC }));
  assert.equal(badDiffRes.status, 200);
  const badDiffJson = await badDiffRes.json();
  assert.equal(badDiffJson.verdict, "BLOCK");
  assert.ok(badDiffJson.blockers.includes("forbidden_file:.env"));
  assert.ok(badDiffJson.blockers.includes("trivial_or_skipped_test_in_diff"));
  assert.ok(badDiffJson.blockers.includes("test_output_contradicts_pass_claim"));

  // 2. Blind Judge (0.10 USDC = 100000 micros) catches swap position bias & computes Elo
  const unpJudge = await call("/api/v1/x402/blind-judge", { pass1: { winner: "B" }, pass2: { winner: "A" } });
  assert.equal(unpJudge.status, 402);
  const judgeHdr = JSON.parse(Buffer.from(unpJudge.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(judgeHdr.accepts[0].maxAmountRequired, "100000");

  const sigJ = "1".repeat(63) + "b";
  const refJ = judgeHdr.accepts[0].extra.reference;
  const txJ = transaction(refJ, 100000);
  txJ.transaction.signatures[0] = sigJ;
  globalThis.fetch = async () => Response.json({ result: txJ });

  const winJudgeRes = await postPaid("/api/v1/x402/blind-judge", {
    pass1: { winner: "B", score_a: 75, score_b: 92 },
    pass2: { winner: "A", score_a: 90, score_b: 76 },
  }, JSON.stringify({ signature: sigJ, reference: refJ }));
  assert.equal(winJudgeRes.status, 200);
  const winJudge = await winJudgeRes.json();
  assert.equal(winJudge.winner, "challenger");
  assert.equal(winJudge.debiased_consistent, true);
  assert.ok(winJudge.elo_delta > 0);

  const sigJ2 = "1".repeat(63) + "c";
  const refJ2 = newReference();
  const txJ2 = transaction(refJ2, 100000);
  txJ2.transaction.signatures[0] = sigJ2;
  globalThis.fetch = async () => Response.json({ result: txJ2 });
  const revJudgeRes = await postPaid("/api/v1/x402/blind-judge", {
    pass1: { winner: "B", score_a: 80, score_b: 88 },
    pass2: { winner: "B", score_a: 80, score_b: 88 },
  }, JSON.stringify({ signature: sigJ2, reference: refJ2 }));
  assert.equal(revJudgeRes.status, 200);
  const revJudge = await revJudgeRes.json();
  assert.equal(revJudge.winner, "tie");
  assert.equal(revJudge.debiased_consistent, false);

  // 3. Protected /api/funnel/bounty-feed push -> paid /api/v1/x402/bounty-feed (0.05 USDC)
  const unauthFeed = await call("/api/funnel/bounty-feed", { items: [] });
  assert.equal(unauthFeed.status, 401);
  const pushRes = await call("/api/funnel/bounty-feed", {
    items: [
      { title: "Fix Algora bug", url: "https://github.com/org/repo/issues/1", source: "algora", bounty_usd: 250, open_prs: 0 },
      { title: "Small issue", url: "https://github.com/org/repo/issues/2", source: "opire", bounty_usd: 20, open_prs: 0 },
    ],
  }, "Bearer local-policy");
  assert.equal(pushRes.status, 200);
  assert.equal((await pushRes.json()).updated, 2);

  const sigF = "1".repeat(63) + "d";
  const refF = newReference();
  const txF = transaction(refF, 50000);
  txF.transaction.signatures[0] = sigF;
  globalThis.fetch = async () => Response.json({ result: txF });
  const feedRes = await postPaid("/api/v1/x402/bounty-feed", { min_usd: 100, source: "algora" }, JSON.stringify({ signature: sigF, reference: refF }));
  assert.equal(feedRes.status, 200);
  const feedJson = await feedRes.json();
  assert.equal(feedJson.count, 1);
  assert.equal(feedJson.items[0].bounty_usd, 250);
});

test("x402 v3 endpoints: stealth-extract (0.05 USDC) and quant-overfit-score (0.25 USDC)", async t => {
  const { env, call } = setup(t);
  const localFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = localFetch; });

  const postPaid = (path, payload, payHdr) => worker.fetch(new Request(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payHdr },
    body: JSON.stringify(payload),
  }), env, { waitUntil() {} });

  // 1. stealth-extract 402 + SSRF block + settled 200 HTML/JSON-LD extraction
  const unpExt = await call("/api/v1/x402/stealth-extract", { html: "<h1>Hi</h1>" });
  assert.equal(unpExt.status, 402);
  const extHdr = JSON.parse(Buffer.from(unpExt.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(extHdr.accepts[0].maxAmountRequired, "50000");

  const ssrfExt = await postPaid(
    "/api/v1/x402/stealth-extract",
    { url: "https://127.0.0.1/secret" },
    JSON.stringify({ signature: "1".repeat(63) + "e" })
  );
  assert.equal(ssrfExt.status, 400);

  const sigE = "1".repeat(63) + "f";
  const refE = extHdr.accepts[0].extra.reference;
  const txE = transaction(refE, 50000);
  txE.transaction.signatures[0] = sigE;
  globalThis.fetch = async () => Response.json({ result: txE });

  const extRes = await postPaid(
    "/api/v1/x402/stealth-extract",
    {
      html: '<html><head><title>Audit Demo</title><script type="application/ld+json">{"@type":"SoftwareApplication","name":"mcp-guard"}</script></head><body><h1>Main Header</h1><p>Clean body text.</p></body></html>',
    },
    JSON.stringify({ signature: sigE, reference: refE })
  );
  assert.equal(extRes.status, 200);
  const extData = await extRes.json();
  assert.equal(extData.title, "Audit Demo");
  assert.equal(extData.headings[0].text, "Main Header");
  assert.equal(extData.jsonld_count, 1);

  // 2. quant-overfit-score 402 + validation 400 + noisy REJECTED_OVERFIT + strong APPROVED_EDGE
  const unpQ = await call("/api/v1/x402/quant-overfit-score", { returns: Array(30).fill(0.001) });
  assert.equal(unpQ.status, 402);
  const qHdr = JSON.parse(Buffer.from(unpQ.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(qHdr.accepts[0].maxAmountRequired, "250000");

  const badQ = await postPaid(
    "/api/v1/x402/quant-overfit-score",
    { returns: [0.01, 0.02] },
    JSON.stringify({ signature: "1".repeat(63) + "g" })
  );
  assert.equal(badQ.status, 400);

  // Noisy returns with 80 trials -> REJECTED_OVERFIT
  const sigQ1 = "1".repeat(63) + "h";
  const refQ1 = qHdr.accepts[0].extra.reference;
  const txQ1 = transaction(refQ1, 250000);
  txQ1.transaction.signatures[0] = sigQ1;
  globalThis.fetch = async () => Response.json({ result: txQ1 });
  const noisy = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.011 : -0.010));
  const qRes1 = await postPaid(
    "/api/v1/x402/quant-overfit-score",
    { returns: noisy, n_trials: 80, cost_bps: 15 },
    JSON.stringify({ signature: sigQ1, reference: refQ1 })
  );
  assert.equal(qRes1.status, 200);
  const qJson1 = await qRes1.json();
  assert.equal(qJson1.verdict, "REJECTED_OVERFIT");
  assert.equal(qJson1.paper_only, true);

  // Strong clean return series with 2 trials -> APPROVED_EDGE & Quarter-Kelly <= 0.25
  const sigQ2 = "1".repeat(63) + "i";
  const refQ2 = newReference();
  const txQ2 = transaction(refQ2, 250000);
  txQ2.transaction.signatures[0] = sigQ2;
  globalThis.fetch = async () => Response.json({ result: txQ2 });
  const strong = Array.from({ length: 120 }, (_, i) => (i % 5 === 0 ? -0.002 : 0.009));
  const qRes2 = await postPaid(
    "/api/v1/x402/quant-overfit-score",
    { returns: strong, n_trials: 2, cost_bps: 10 },
    JSON.stringify({ signature: sigQ2, reference: refQ2 })
  );
  assert.equal(qRes2.status, 200);
  const qJson2 = await qRes2.json();
  assert.equal(qJson2.verdict, "APPROVED_EDGE");
  assert.ok(qJson2.deflated_sharpe_prob >= 0.95);
  assert.ok(qJson2.quarter_kelly_cap > 0 && qJson2.quarter_kelly_cap <= 0.25);
});

test("x402 freemium: 5 free calls/day with X-MCP-Trial: 1 -> call #6 returns 402 trial_exhausted, non-trial stays 402", async t => {
  const { env, call } = setup(t);
  const localFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = localFetch; });

  // 1. Discovery manifest advertises freemium & CORS exposes trial headers
  const discRes = await call("/.well-known/x402.json");
  assert.equal(discRes.status, 200);
  assert.ok(discRes.headers.get("access-control-allow-headers").includes("X-MCP-Trial"));
  assert.ok(discRes.headers.get("access-control-expose-headers").includes("X-Free-Tier"));
  assert.ok(discRes.headers.get("access-control-expose-headers").includes("X-Free-Remaining"));
  assert.ok(discRes.headers.get("access-control-expose-headers").includes("X-Free-Limit"));
  const disc = await discRes.json();
  assert.deepEqual(disc.freemium, {
    enabled: true,
    dailyFreeCallsPerIp: 5,
    header: "X-MCP-Trial: 1",
    mcpServerInstall: "npx -y github:thongtuehuu-cyber/mcp-guard-kit",
  });

  const postReq = (path, payload, extraHeaders = {}) => worker.fetch(new Request(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload),
  }), env, { waitUntil() {} });

  const auditPayload = {
    traces: [
      {
        case_id: "trial-1",
        tool_name: "charge",
        fault_id: "silent_error_200",
        tool_response: { status_code: 200, body: { paid: false, error: "card_declined" } },
        agent_claim: "Payment completed successfully!",
        required_keys: ["charge_id"],
      },
    ],
  };

  // 2. Requests WITHOUT X-MCP-Trial: 1 MUST continue returning HTTP 402 immediately (100% backward compatible)
  const nonTrial = await postReq("/api/v1/x402/mcp-audit", auditPayload, { "cf-connecting-ip": "203.0.113.10" });
  assert.equal(nonTrial.status, 402);
  const nonTrialBody = await nonTrial.json();
  assert.equal(nonTrialBody.trial_exhausted, undefined);
  assert.ok(nonTrial.headers.get("payment-required"));

  // 3. Non-freemium endpoints (blind-judge, bounty-feed) remain HTTP 402 even with X-MCP-Trial: 1
  const nonEligible = await postReq(
    "/api/v1/x402/blind-judge",
    { pass1: { winner: "B" }, pass2: { winner: "A" } },
    { "x-mcp-trial": "1", "cf-connecting-ip": "203.0.113.10" }
  );
  assert.equal(nonEligible.status, 402);

  // 4. Invalid request under trial returns 400 and does NOT consume free quota
  const badTrial = await postReq(
    "/api/v1/x402/stealth-extract",
    { url: "https://127.0.0.1/internal" },
    { "x-mcp-trial": "1", "cf-connecting-ip": "203.0.113.10" }
  );
  assert.equal(badTrial.status, 400);

  // 5. Calls 1..5 across freemium-eligible endpoints return HTTP 200 with decrementing X-Free-Remaining
  const trialCalls = [
    { path: "/api/v1/x402/mcp-audit", usdc: "0.05", payload: auditPayload },
    { path: "/api/v1/x402/pr-critic", usdc: "0.15", payload: { diff: "diff --git a/a.py b/a.py\n+++ b/a.py\n+x = 1\n" } },
    {
      path: "/api/v1/x402/quant-overfit-score",
      usdc: "0.25",
      payload: { returns: Array.from({ length: 30 }, (_, i) => (i % 4 === 0 ? -0.001 : 0.004)), n_trials: 2 },
    },
    { path: "/api/v1/x402/stealth-extract", usdc: "0.05", payload: { html: "<html><head><title>T</title></head><body><h1>H1</h1></body></html>" } },
    {
      path: "/api/v1/x402/price-extract",
      usdc: "0.05",
      payload: {
        adapter: "jsonld",
        currency: "USD",
        html: '<script type="application/ld+json">{"@type":"Product","name":"Item","offers":{"@type":"Offer","price":"9.50","priceCurrency":"USD"}}</script>',
      },
    },
  ];

  for (let i = 0; i < trialCalls.length; i++) {
    const tc = trialCalls[i];
    const res = await postReq(tc.path, tc.payload, { "x-mcp-trial": "1", "cf-connecting-ip": "203.0.113.10" });
    assert.equal(res.status, 200, `Expected 200 on trial call #${i + 1} (${tc.path})`);
    assert.equal(res.headers.get("x-free-tier"), "1");
    assert.equal(res.headers.get("x-free-limit"), "5");
    assert.equal(res.headers.get("x-free-remaining"), String(4 - i));
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.freemium, {
      used: i + 1,
      limit: 5,
      remaining: 4 - i,
      upgrade_x402_usdc: tc.usdc,
    });
  }

  // 6. Call #6 from same IP returns HTTP 402 + PAYMENT-REQUIRED + trial_exhausted: true
  const sixth = await postReq("/api/v1/x402/mcp-audit", auditPayload, { "x-mcp-trial": "1", "cf-connecting-ip": "203.0.113.10" });
  assert.equal(sixth.status, 402);
  const sixthBody = await sixth.json();
  assert.equal(sixthBody.trial_exhausted, true);
  assert.equal(sixthBody.accepts[0].maxAmountRequired, "50000");
  const sixthHdr = JSON.parse(Buffer.from(sixth.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(sixthHdr.trial_exhausted, true);

  // 7. Another IP (via X-Forwarded-For) still gets its own fresh 5/day allowance
  const otherIpRes = await postReq("/api/v1/x402/mcp-audit", auditPayload, { "x-mcp-trial": "1", "x-forwarded-for": "198.51.100.77, 10.0.0.1" });
  assert.equal(otherIpRes.status, 200);
  assert.equal(otherIpRes.headers.get("x-free-remaining"), "4");

  // 8. Exhausted IP paying via X-PAYMENT bypasses trial and succeeds with 200 + x-payment-response
  const paidSig = "1".repeat(63) + "z";
  const paidRef = sixthBody.accepts[0].extra.reference;
  const txPaid = transaction(paidRef, 50000);
  txPaid.transaction.signatures[0] = paidSig;
  globalThis.fetch = async () => Response.json({ result: txPaid });

  const paidAfterTrial = await postReq("/api/v1/x402/mcp-audit", auditPayload, {
    "x-mcp-trial": "1",
    "cf-connecting-ip": "203.0.113.10",
    "x-payment": JSON.stringify({ signature: paidSig, reference: paidRef }),
  });
  assert.equal(paidAfterTrial.status, 200);
  assert.equal(paidAfterTrial.headers.get("x-free-tier"), null);
  assert.ok(paidAfterTrial.headers.get("x-payment-response"));
});
