# 24/7 Solana Pay Auto-Fulfillment (Cloudflare Worker + D1 + KV + Resend)

Live Worker origin: `https://mcp-guard-solana-fulfillment.daochienthangkt.workers.dev`

## Architecture ($0 Free Tier)
- **Database:** Cloudflare D1 (`mcp-guard-orders`, `fe64f5cc-f168-490e-837c-df02613815a3`) stores `visits`, `orders`, `usage_releases`, and `commerce_events` (`migrations/0001_commerce.sql`).
- **Private Pro Artifact:** Cloudflare Workers KV namespace (`PRO_FILES_KV` -> `mcp-guard-pro-files`, `e607e1b5c7694b7fbb0f4aeac8d57944`) stores private binary `mcp-guard-kit-pro-v1.1.zip` streamed behind 7-day HMAC-SHA256 `/download` tokens (`HMAC_SECRET` Worker secret).
- **On-Chain Finality Check + Instant Download:** `/checkout` creates a unique per-order Solana Pay `reference` pubkey for `3.25 USDC` to `GPrbk8Lj3ZBCM26TzE3Zv1Dg9z2pJwMaZuc7sA5qCEXF`, verifies finalized SPL transfer instructions via Solana Mainnet RPC, and unlocks immediate `/download`.
- **Automated Email Delivery (Resend + 5-min Cron Outbox):** Sends from verified domain `MCP Guard Studio <orders@mail.staai.click>` (reply-to `thongtuehuu@gmail.com`) via Resend REST API with `Idempotency-Key` and `*/5 * * * *` exponential retry outbox (also falls back to `BREVO_API_KEY` if configured).

## Required & Optional Worker Secrets
Add secrets directly in **Cloudflare Dashboard → Workers & Pages → `mcp-guard-solana-fulfillment` → Settings → Variables and Secrets** (never commit secrets):
- `RESEND_API_KEY`: Resend API key (`re_...`) for automated email delivery from `orders@mail.staai.click`.
- `HMAC_SECRET`: Already provisioned on the deployed Worker (signs 7-day `/download` URLs).
- `HELIUS_AUTH_SECRET` *(optional)*: Shared secret header for Helius Enhanced Webhook targeting `https://mcp-guard-solana-fulfillment.daochienthangkt.workers.dev/api/helius-webhook` watching `GPrbk8Lj3ZBCM26TzE3Zv1Dg9z2pJwMaZuc7sA5qCEXF`.
- `COMMERCE_FEED_TOKEN` *(optional)*: Bearer token for `radar_dashboard` (`RADAR_COMMERCE_ORIGIN` + `RADAR_COMMERCE_FEED_TOKEN`) to import anonymized funnel telemetry via `/api/funnel/events`.
