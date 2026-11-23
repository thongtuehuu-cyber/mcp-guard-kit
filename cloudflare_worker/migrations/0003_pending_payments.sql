ALTER TABLE orders ADD COLUMN next_chain_check INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS orders_unpaid_due ON orders(next_chain_check, created_at)
WHERE signature IS NULL;
