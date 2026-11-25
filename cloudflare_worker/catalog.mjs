export const SKU_CATALOG = {
  solo: {
    sku: "solo",
    name: "MCP Guard Kit Pro v1.2 — Solo",
    shortEn: "30 chaos scenarios, stdio/HTTP proxies, pytest plugin, policy gates & SARIF/HTML reports.",
    shortVi: "30 kịch bản lỗi, proxy stdio/HTTP, plugin pytest, policy gate & báo cáo SARIF/HTML.",
    micros: 19000000,
    envKey: "PRO_V12_ZIP_KEY",
    defaultKey: "mcp-guard-kit-pro-v1.2.zip",
    filename: "mcp-guard-kit-pro-v1.2.zip",
    highlightsEn: [
      "30 fault scenarios across Stripe, GitHub, Postgres, Slack, Playwright & MCP Core",
      "Live proxy-stdio (stderr-safe) & Streamable-HTTP chaos proxies with --rules-file",
      "PolicyConfig CLI gates (--policy), mcp-guard-pro init & SARIF 2.1 / JUnit / HTML",
      "Perpetual commercial license for solo engineers & client projects",
    ],
    highlightsVi: [
      "30 kịch bản lỗi Stripe, GitHub, Postgres, Slack, Playwright & MCP Core",
      "Proxy stdio (chống treo stderr) & proxy Streamable-HTTP hỗ trợ --rules-file",
      "Kiểm tra qua --policy JSON, lệnh init nhanh & xuất SARIF 2.1 / JUnit / HTML",
      "Bản quyền thương mại vĩnh viễn cho lập trình viên cá nhân & dự án khách hàng",
    ],
  },
  team: {
    sku: "team",
    name: "MCP Guard Kit Pro v1.2 — Team CI Pack",
    shortEn: "Unlimited org CI runners, PR blocking SARIF workflow, release comparison & policy starter pack.",
    shortVi: "Không giới hạn repo & runner CI cho team, workflow chặn PR SARIF & so sánh release.",
    micros: 79000000,
    envKey: "PRO_V12_ZIP_KEY",
    defaultKey: "mcp-guard-kit-pro-v1.2.zip",
    filename: "mcp-guard-kit-pro-v1.2.zip",
    highlightsEn: [
      "Everything in Solo Pro v1.2 licensed for unlimited organization repos & CI runners",
      "GitHub Actions PR Gate template (SARIF Code Scanning + baseline compare regression)",
      "Distill/replay synthetic regression generator (never leaks raw customer traces)",
      "Starter policy & multi-tool proxy chaos rules ready for shared QA pipelines",
    ],
    highlightsVi: [
      "Full tính năng Solo Pro v1.2 bản quyền cho toàn bộ repo & CI runner của tổ chức",
      "Template GitHub Actions chặn PR (SARIF Code Scanning + compare phát hiện tụt chuẩn)",
      "Bộ sinh test hồi quy distill/replay ẩn danh (không lộ payload khách hàng)",
      "Bộ policy & rules chuẩn sẵn sàng cho pipeline QA dùng chung của team",
    ],
  },
  "deal-monitor": {
    sku: "deal-monitor",
    name: "Deal Monitor Self-Hosted v1.2",
    shortEn: "6 price adapters (GOG/Steam/Shopify/JSON-LD/JSON-Path/Playwright), Discord/Telegram/Webhook & Docker.",
    shortVi: "6 adapter giá (GOG/Steam/Shopify/JSON-LD/JSON-Path/Playwright), báo Discord/Telegram/Webhook & Docker.",
    micros: 19000000,
    envKey: "DEAL_MONITOR_ZIP_KEY",
    defaultKey: "deal-monitor-self-hosted-v1.2.zip",
    filename: "deal-monitor-self-hosted-v1.2.zip",
    highlightsEn: [
      "6 storefront adapters: Schema.org JSON-LD (AggregateOffer), Shopify JSON, Steam, GOG, JSON-Path, Playwright",
      "4 retry-safe alert channels in SQLite outbox: Discord, Telegram, ntfy & signed Webhook",
      "Safe HTTPS-only redirect validation, CSV history export & 30-day SVG HTML dashboard",
      "Includes Dockerfile, docker-compose.yml & example watchlists (MIT licensed)",
    ],
    highlightsVi: [
      "6 adapter lấy giá: JSON-LD (gồm AggregateOffer), Shopify JSON, Steam, GOG, JSON-Path, Playwright",
      "4 kênh báo kèo chống mất tin trong SQLite: Discord, Telegram, ntfy & Webhook",
      "Chặn redirect hạ cấp HTTP/IP nội bộ, xuất CSV lịch sử & biểu đồ SVG 30 ngày",
      "Kèm sẵn Dockerfile, docker-compose.yml & watchlist mẫu (MIT License)",
    ],
  },
  starter: {
    sku: "starter",
    name: "MCP Guard Kit Pro — Starter Archive",
    shortEn: "Standalone v1.1 archive with 24 MCP fault scenarios, stdio/HTTP proxies & pytest fixtures.",
    shortVi: "Gói v1.1 cơ bản gồm 24 kịch bản lỗi MCP, proxy stdio/HTTP & pytest plugin.",
    micros: 3250000,
    envKey: "PRO_ZIP_KEY",
    defaultKey: "mcp-guard-kit-pro-v1.1.zip",
    filename: "mcp-guard-kit-pro-v1.1.zip",
    highlightsEn: [
      "24 fault scenarios across Stripe, GitHub, Postgres, Slack & Playwright",
      "Stdio & HTTP MCP chaos proxies + pytest11 fixtures + SARIF/JUnit/HTML reports",
    ],
    highlightsVi: [
      "24 kịch bản lỗi Stripe, GitHub, Postgres, Slack & Playwright",
      "Proxy chaos stdio/HTTP + pytest11 fixtures + báo cáo SARIF/JUnit/HTML",
    ],
  },
};

export function resolveProduct(sku, env = {}) {
  if (typeof sku === "string" && sku.trim()) {
    const key = sku.trim().toLowerCase();
    const entry = SKU_CATALOG[key];
    if (!entry) return null;
    if (key === "starter" && env.PRICE_MICROS) {
      return { ...entry, micros: Number(env.PRICE_MICROS), filename: env.PRO_ZIP_KEY || entry.filename };
    }
    return entry;
  }
  const fallbackKey = String(env.DEFAULT_SKU || "starter").trim().toLowerCase();
  const base = SKU_CATALOG[fallbackKey] || SKU_CATALOG.starter;
  if (fallbackKey === "starter" && env.PRICE_MICROS) {
    return { ...base, micros: Number(env.PRICE_MICROS), filename: env.PRO_ZIP_KEY || base.filename };
  }
  return base;
}

export function artifactKeyForProduct(product, env = {}) {
  return (product.envKey && env[product.envKey]) || product.defaultKey;
}
