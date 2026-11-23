-- D1 is authoritative for order identity, payment uniqueness and the delivery outbox.
CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY,
    radar_ref TEXT NOT NULL,
    variant TEXT NOT NULL CHECK (variant IN ('control', 'ci')),
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    reference TEXT PRIMARY KEY,
    visit_id TEXT NOT NULL UNIQUE REFERENCES visits(id),
    email TEXT NOT NULL,
    access_hash TEXT NOT NULL,
    expected_micros INTEGER NOT NULL CHECK (expected_micros > 0),
    created_at INTEGER NOT NULL,
    signature TEXT UNIQUE,
    paid_at INTEGER,
    mail_id TEXT,
    emailed_at INTEGER,
    downloaded_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try INTEGER NOT NULL DEFAULT 0,
    lease TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS orders_due ON orders(next_try, lease_until)
    WHERE paid_at IS NOT NULL AND mail_id IS NULL;

CREATE TABLE IF NOT EXISTS usage_releases (
    reference TEXT NOT NULL REFERENCES orders(reference),
    release_id TEXT NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (reference, release_id)
);

CREATE TABLE IF NOT EXISTS commerce_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id TEXT NOT NULL REFERENCES visits(id),
    stage TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    signature TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL DEFAULT 0,
    release_id TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS commerce_visit AFTER INSERT ON visits BEGIN
    INSERT INTO commerce_events(visit_id, stage, at) VALUES (NEW.id, 'viewed', NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS commerce_order AFTER INSERT ON orders BEGIN
    INSERT INTO commerce_events(visit_id, stage, reference, at)
    VALUES (NEW.visit_id, 'checkout', NEW.reference, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS commerce_paid AFTER UPDATE OF paid_at ON orders
WHEN OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL BEGIN
    INSERT INTO commerce_events(visit_id, stage, reference, signature, amount_cents, at)
    VALUES (NEW.visit_id, 'paid', NEW.reference, NEW.signature, NEW.expected_micros / 10000, NEW.paid_at);
END;
CREATE TRIGGER IF NOT EXISTS commerce_mail AFTER UPDATE OF emailed_at ON orders
WHEN OLD.emailed_at IS NULL AND NEW.emailed_at IS NOT NULL BEGIN
    INSERT INTO commerce_events(visit_id, stage, reference, at)
    VALUES (NEW.visit_id, 'email_accepted', NEW.reference, NEW.emailed_at);
END;
CREATE TRIGGER IF NOT EXISTS commerce_download AFTER UPDATE OF downloaded_at ON orders
WHEN OLD.downloaded_at IS NULL AND NEW.downloaded_at IS NOT NULL BEGIN
    INSERT INTO commerce_events(visit_id, stage, reference, at)
    VALUES (NEW.visit_id, 'download_started', NEW.reference, NEW.downloaded_at);
END;
CREATE TRIGGER IF NOT EXISTS commerce_used AFTER INSERT ON usage_releases BEGIN
    INSERT INTO commerce_events(visit_id, stage, reference, release_id, at)
    SELECT visit_id, 'release_used', reference, NEW.release_id, NEW.used_at
    FROM orders WHERE reference=NEW.reference;
END;
