# 24/7 Solana Pay Auto-Fulfillment (Cloudflare Worker + Helius)

Deploy only once `mcp-guard-kit` hits initial traction (>= 3 sales), keeping zero recurring infrastructure cost:

1. Create a free Cloudflare KV namespace `ORDERS_KV` and bind its ID in `wrangler.toml`.
2. Set Worker secrets (`wrangler secret put`):
   - `HELIUS_AUTH_SECRET`
   - `HMAC_SECRET`
   - `BREVO_API_KEY`
   - `PRO_ZIP_PRIVATE_URL` (private R2 signed URL or private storage URL)
3. Deploy: `npx wrangler deploy`.
4. Create a free Helius webhook watching `GPrbk8Lj3ZBCM26TzE3Zv1Dg9z2pJwMaZuc7sA5qCEXF` targeting `https://<worker>.workers.dev/api/helius-webhook`.
