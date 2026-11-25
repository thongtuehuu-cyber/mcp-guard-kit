# 24/7 Solana Pay Auto-Fulfillment (Multi-SKU · 0% Fee · 0 KYC)

Live Worker origin: `https://pay.staai.click` (custom domain with `workers.dev` disabled)

## Catalog SKUs
- `solo` (**19 USDC**): `mcp-guard-kit-pro-v1.2.zip`
- `team` (**79 USDC**): `mcp-guard-kit-pro-v1.2.zip` (unlimited org CI runners & SARIF gates)
- `deal-monitor` (**19 USDC**): `deal-monitor-self-hosted-v1.2.zip`
- `starter` (**3.25 USDC**): `mcp-guard-kit-pro-v1.1.zip` (backward-compatible starter alias)

## Architecture ($0 Free Tier · Privacy-Hardened)
- **Database:** Cloudflare D1 (`mcp-guard-orders`, `fe64f5cc-f168-490e-837c-df02613815a3`) with `migrations/0004_product_sku.sql`.
- **Artifacts:** Cloudflare Workers KV (`PRO_FILES_KV`, `e607e1b5c7694b7fbb0f4aeac8d57944`) keyed by SKU (`mcp-guard-kit-pro-v1.2.zip`, `deal-monitor-self-hosted-v1.2.zip`, `mcp-guard-kit-pro-v1.1.zip`) behind 7-day HMAC-SHA256 `/download` tokens.
- **Privacy:** Reply-to and sender both use `orders@mail.staai.click` (no personal Gmail exposed).
- **Deploy once logged in (`npx wrangler login`):**
  ```bash
  bash deploy_solana_store.sh
  ```
