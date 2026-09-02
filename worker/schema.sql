-- SecondLine schema (Cloudflare D1 / SQLite)
--
-- Multi-number from the first migration. A Standard A2P brand can carry many
-- numbers across many campaigns, and retrofitting a number_id onto a live
-- messages table later means rewriting every query and every index. It costs
-- almost nothing to carry now and it is the whole reason for registering as a
-- business rather than a sole proprietor.

/* ---------- the lines we own ---------- */

CREATE TABLE IF NOT EXISTS numbers (
  id            TEXT PRIMARY KEY,
  e164          TEXT NOT NULL UNIQUE,      -- +18152870166
  label         TEXT,                      -- "Personal second line"
  twilio_sid    TEXT,                      -- PN... once purchased or ported in
  -- Where unanswered calls ring before falling through to voicemail. NULL
  -- sends callers straight to voicemail without ringing anything.
  forward_to    TEXT,
  -- Seconds to ring forward_to before giving up and recording.
  forward_timeout_sec INTEGER NOT NULL DEFAULT 20,
  greeting_mode TEXT NOT NULL DEFAULT 'tts',  -- tts | audio
  greeting_text TEXT,
  greeting_key  TEXT,                      -- R2 key when greeting_mode = 'audio'
  -- A2P campaign this number is attached to. Sole Proprietor allows exactly
  -- one number per campaign; Standard allows many, which is why this is a
  -- plain column and not a uniqueness constraint.
  campaign_sid  TEXT,
  messaging_service_sid TEXT,
  -- Where transcripts and alerts for THIS line go. Each line can route to a
  -- different address — a personal line and a business line rarely want the
  -- same inbox. NULL falls back to OWNER_EMAIL.
  notify_email  TEXT,
  -- Email every inbound text on this line, not just voicemail. Off by default:
  -- on a busy line it is unusable. Worth turning on for a low-traffic project
  -- number you would otherwise forget to check.
  email_texts   INTEGER NOT NULL DEFAULT 0,
  -- Random per-line string stamped on every email for this number, so a mail
  -- rule can route the line's notifications without matching on words a real
  -- message might contain. A label like "Quest" would forward any personal
  -- mail that happened to mention a quest; this cannot collide with anything.
  route_token   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

/* ---------- conversations ---------- */

-- One thread per (our number, their number). The same person texting two of
-- our numbers is two threads, because the reply has to go back out from the
-- number they contacted.
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  number_id       TEXT NOT NULL,
  peer_number     TEXT NOT NULL,
  contact_id      TEXT,
  last_message_at INTEGER,
  last_preview    TEXT,                    -- denormalised for the thread list
  unread_count    INTEGER NOT NULL DEFAULT 0,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  is_blocked      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (number_id, peer_number)
);

CREATE INDEX IF NOT EXISTS idx_threads_recent
  ON threads (is_archived, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  number_id    TEXT NOT NULL,
  direction    TEXT NOT NULL,              -- inbound | outbound
  peer_number  TEXT NOT NULL,
  body         TEXT,
  -- Twilio's own lifecycle: queued, sending, sent, delivered, undelivered,
  -- failed, received. Kept verbatim so status callbacks map straight in.
  status       TEXT NOT NULL DEFAULT 'received',
  twilio_sid   TEXT UNIQUE,                -- SM/MM..., also the retry guard
  error_code   INTEGER,                    -- 30007 carrier filtering, etc.
  num_media    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  read_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (direction, read_at);

-- MMS attachments. Twilio deletes its copy once we have ours, same as the
-- voicemail audio, so R2 is the only place a picture someone sent you lives.
CREATE TABLE IF NOT EXISTS media (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  content_type TEXT,
  size_bytes   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_message ON media (message_id);

/* ---------- calls ---------- */

CREATE TABLE IF NOT EXISTS calls (
  id           TEXT PRIMARY KEY,
  number_id    TEXT NOT NULL,
  direction    TEXT NOT NULL,              -- inbound | outbound
  peer_number  TEXT NOT NULL,
  peer_name    TEXT,                       -- CNAM, when Twilio has it
  peer_city    TEXT,
  peer_state   TEXT,
  contact_id   TEXT,
  -- answered | missed | voicemail | busy | failed | in-progress
  disposition  TEXT NOT NULL DEFAULT 'in-progress',
  duration_sec INTEGER NOT NULL DEFAULT 0,
  twilio_sid   TEXT UNIQUE,
  created_at   INTEGER NOT NULL,
  read_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_calls_recent ON calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_missed ON calls (disposition, read_at);

CREATE TABLE IF NOT EXISTS voicemails (
  id                    TEXT PRIMARY KEY,
  call_id               TEXT,
  number_id             TEXT NOT NULL,
  from_number           TEXT NOT NULL,
  contact_id            TEXT,
  duration_sec          INTEGER NOT NULL DEFAULT 0,
  r2_key                TEXT,
  recording_sid         TEXT,
  transcript            TEXT,
  transcript_status     TEXT NOT NULL DEFAULT 'pending',  -- pending|done|failed|skipped
  transcript_provider   TEXT,
  transcript_confidence REAL,
  is_read               INTEGER NOT NULL DEFAULT 0,
  is_saved              INTEGER NOT NULL DEFAULT 0,       -- exempt from purge
  deleted_at            INTEGER,                          -- soft delete
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vm_created ON voicemails (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vm_deleted ON voicemails (deleted_at);
CREATE INDEX IF NOT EXISTS idx_vm_unread  ON voicemails (is_read, deleted_at);

/* ---------- contacts ---------- */

-- Shared across every line. One person, however many numbers they reach you
-- from and whichever of your numbers they call.
CREATE TABLE IF NOT EXISTS contacts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS contact_numbers (
  number     TEXT PRIMARY KEY,             -- E.164
  contact_id TEXT NOT NULL,
  label      TEXT,                         -- mobile | work | ...
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_numbers ON contact_numbers (contact_id);

/* ---------- auth ---------- */
-- Carried over from Mint Voicemail unchanged. Single user by construction:
-- no registration, no user table, nothing to enumerate.

CREATE TABLE IF NOT EXISTS credentials (
  id           TEXT PRIMARY KEY,           -- credential ID, base64url
  public_key   TEXT NOT NULL,              -- COSE public key, base64url
  counter      INTEGER DEFAULT 0,
  transports   TEXT,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,               -- reg | auth | magic
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ch_expires ON challenges (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  user_agent   TEXT,
  ip           TEXT,
  method       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sess_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket   TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
