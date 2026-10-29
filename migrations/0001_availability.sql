CREATE TABLE IF NOT EXISTS availability_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('fresh', 'stale', 'unavailable')),
  window_start TEXT,
  window_end TEXT,
  updated_at TEXT,
  last_attempt_at TEXT,
  busy_json TEXT NOT NULL CHECK (json_valid(busy_json)),
  CHECK (
    (updated_at IS NULL AND window_start IS NULL AND window_end IS NULL)
    OR (updated_at IS NOT NULL AND window_start IS NOT NULL AND window_end IS NOT NULL)
  )
);

INSERT OR IGNORE INTO availability_snapshot
  (id, status, window_start, window_end, updated_at, last_attempt_at, busy_json)
VALUES
  (1, 'unavailable', NULL, NULL, NULL, NULL, '[]');
