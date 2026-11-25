CREATE TABLE IF NOT EXISTS x402_calls (
    signature TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS x402_calls_created ON x402_calls(created_at DESC);
