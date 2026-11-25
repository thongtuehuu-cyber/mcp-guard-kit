#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "[1/4] Applying remote D1 migration 0004_product_sku.sql..."
npx wrangler d1 execute mcp-guard-orders --remote --file=migrations/0004_product_sku.sql

echo "[2/4] Uploading v1.2 artifacts to PRO_FILES_KV..."
npx wrangler kv key put --namespace-id=e607e1b5c7694b7fbb0f4aeac8d57944 \
  "mcp-guard-kit-pro-v1.2.zip" --path="../../dist/mcp-guard-kit-pro-v1.2.zip" --remote
npx wrangler kv key put --namespace-id=e607e1b5c7694b7fbb0f4aeac8d57944 \
  "deal-monitor-self-hosted-v1.2.zip" --path="../../dist/deal-monitor-self-hosted-v1.2.zip" --remote

echo "[3/4] Running unit tests..."
node --test test/commerce.test.mjs

echo "[4/4] Deploying Worker..."
npx wrangler deploy
