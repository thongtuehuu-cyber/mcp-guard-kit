const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function decode58(text) {
  if (typeof text !== "string" || text.length > 130) return [];
  let number = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return [];
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return bytes;
}

export function newReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let value = 0n;
  let prefix = "";
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  for (const byte of bytes) {
    if (byte !== 0) break;
    prefix += "1";
  }
  let encoded = "";
  while (value) {
    encoded = ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return prefix + encoded;
}

export function solanaLink(wallet, order, label = "MCP Guard Studio") {
  const params = new URLSearchParams({
    amount: String(order.expected_micros / 1000000),
    "spl-token": USDC,
    reference: order.reference,
    label,
  });
  return "solana:" + wallet + "?" + params.toString();
}

// Solana Pay places the reference on the SPL transfer instruction itself.
// A reference elsewhere in the transaction cannot identify a purchase.
export function isOrderTransfer(tx, signature, order, wallet) {
  if (!tx?.meta || tx.meta.err || tx.transaction?.signatures?.[0] !== signature) return false;
  if (!Number.isFinite(tx.blockTime) || tx.blockTime * 1000 < order.created_at - 60000) return false;
  const msg = tx.transaction.message;
  const keys = [...msg.accountKeys, ...(tx.meta.loadedAddresses?.writable || []),
    ...(tx.meta.loadedAddresses?.readonly || [])];
  const referenceIndex = keys.indexOf(order.reference);
  if (referenceIndex < 0) return false;
  const balances = tx.meta.postTokenBalances || [];
  const before = tx.meta.preTokenBalances || [];
  return msg.instructions.some(ix => {
    if (keys[ix.programIdIndex] !== TOKEN_PROGRAM || !Array.isArray(ix.accounts)) return false;
    const raw = decode58(ix.data);
    const checked = raw[0] === 12;
    if (checked ? raw.length !== 10 || raw[9] !== 6 : raw[0] !== 3 || raw.length !== 9) return false;
    if (checked && keys[ix.accounts[1]] !== USDC) return false;
    if (!ix.accounts.slice(checked ? 4 : 3).includes(referenceIndex)) return false;
    const dest = ix.accounts[checked ? 2 : 1];
    const post = balances.find(b => b.accountIndex === dest && b.owner === wallet && b.mint === USDC);
    if (!post || post.uiTokenAmount.decimals !== 6) return false;
    const pre = before.find(b => b.accountIndex === dest && b.mint === USDC);
    let units = 0n;
    for (let i = 8; i > 0; i--) units = (units << 8n) + BigInt(raw[i]);
    return units === BigInt(order.expected_micros) &&
      BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount || "0") >= units;
  });
}

export async function confirmPayment(env, signature, order) {
  if (order.signature) return order.signature === signature ? "confirmed" : "mismatch";
  if (decode58(signature).length !== 64) return "mismatch";
  const response = await fetch(env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }] }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Solana RPC unavailable");
  const payload = await response.json();
  if (payload.error || !payload.result) return "pending";
  if (!isOrderTransfer(payload.result, signature, order, env.MERCHANT_WALLET)) return "mismatch";
  const saved = await env.COMMERCE_DB.prepare(
    "UPDATE OR IGNORE orders SET signature=?, paid_at=? WHERE reference=? AND signature IS NULL"
  ).bind(signature, payload.result.blockTime * 1000, order.reference).run();
  if (saved.meta.changes === 1) return "confirmed";
  const winner = await env.COMMERCE_DB.prepare("SELECT signature FROM orders WHERE reference=?")
    .bind(order.reference).first();
  return winner?.signature === signature ? "confirmed" : "mismatch";
}

export async function reconcilePending(env) {
  const db = env.COMMERCE_DB;
  const now = Date.now();
  const day = 86400000;
  const due = await db.prepare(
    `SELECT * FROM orders WHERE signature IS NULL AND created_at>=? AND next_chain_check<=?
     ORDER BY next_chain_check, created_at DESC LIMIT 3`
  ).bind(now - 30*day, now).all();
  for (const order of due.results) {
    const interval = now - order.created_at < 2*day ? 5*60000 : 6*3600000;
    const lease = await db.prepare(
      "UPDATE orders SET next_chain_check=? WHERE reference=? AND signature IS NULL AND next_chain_check<=?"
    ).bind(now + interval, order.reference, now).run();
    if (!lease.meta.changes) continue;
    const response = await fetch(env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
        params: [order.reference, { limit: 3, commitment: "finalized" }] }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error("Solana reference lookup unavailable");
    const result = await response.json();
    if (!Array.isArray(result.result)) throw new Error("Invalid signature lookup result");
    for (const tx of result.result) {
      if (tx.err || !tx.signature) continue;
      if (await confirmPayment(env, tx.signature, order) === "confirmed") break;
    }
  }
}
