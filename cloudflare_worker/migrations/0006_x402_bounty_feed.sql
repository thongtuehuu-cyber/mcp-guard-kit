CREATE TABLE IF NOT EXISTS x402_bounty_feed (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  payload_json TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
