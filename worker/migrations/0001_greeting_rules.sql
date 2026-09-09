-- Per-caller greetings: one line, different greetings for different callers.
CREATE TABLE IF NOT EXISTS greeting_rules (
  id            TEXT PRIMARY KEY,
  number_id     TEXT NOT NULL,
  caller_number TEXT NOT NULL,
  label         TEXT,
  greeting_mode TEXT NOT NULL DEFAULT 'tts',
  greeting_text TEXT,
  greeting_key  TEXT,
  skip_forward  INTEGER NOT NULL DEFAULT 1,
  starts_at     INTEGER,
  ends_at       INTEGER,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_lookup
  ON greeting_rules (number_id, caller_number, is_active);
