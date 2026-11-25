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
  for (const name of ["0001_commerce.sql", "0002_offer_policy.sql", "0003_pending_payments.sql", "0004_product_sku.sql"]) {
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
