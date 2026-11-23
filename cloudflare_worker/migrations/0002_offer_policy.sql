ALTER TABLE visits ADD COLUMN exploration INTEGER NOT NULL DEFAULT 1 CHECK(exploration IN (0,1));
CREATE TABLE IF NOT EXISTS offer_policy (
    radar_ref TEXT PRIMARY KEY,
    winner TEXT NOT NULL CHECK(winner IN ('ci','control')),
    expires_at INTEGER NOT NULL
);
