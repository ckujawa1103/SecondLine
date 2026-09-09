#!/usr/bin/env node
// Fold the Mint Voicemail line into SecondLine.
//
//   node scripts/import-mint.mjs sql   > /tmp/mint.sql   emit the backfill
//   node scripts/import-mint.mjs keys  > /tmp/keys.txt   list R2 objects to copy
//
// Mint Voicemail is a single-number app: every voicemail in it belongs to one
// line, so the import is a straight projection of its rows onto SecondLine's
// multi-number schema plus a synthetic `calls` row per message (Mint never
// logged answered calls, so a voicemail is the only call it knows about).
//
// This COPIES. Nothing is deleted from mint-voicemail's D1 or R2, so pointing
// the Twilio webhook back at it remains a working rollback.
//
// Reads the export produced by:
//   wrangler d1 execute mint-voicemail --remote --json \
//     --command "SELECT * FROM voicemails" > mint-export.json

import { readFileSync } from 'node:fs';

const CATCHER = '+18158002292';   // the Twilio number Mint forwards to
const SERVES  = '+16319424439';   // the number callers actually dial

const file = process.argv[3] || 'mint-export.json';
const raw = JSON.parse(readFileSync(file, 'utf8'));
const rows = (Array.isArray(raw) ? raw[0] : raw).results || [];

// Deterministic ids: re-running the import must not duplicate rows. A hash of
// the source id is stable across runs and cannot collide with the random ids
// SecondLine mints for live traffic.
function id(prefix, src) {
  let h = 0n;
  for (const ch of `${prefix}:${src}`) h = (h * 131n + BigInt(ch.codePointAt(0))) % (1n << 64n);
  return `mv${h.toString(36).padStart(13, '0').slice(0, 13)}`;
}

const q = (v) =>
  v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const n = (v) => (v === null || v === undefined ? 'NULL' : Number(v));

const cmd = process.argv[2];

if (cmd === 'keys') {
  for (const r of rows) if (r.r2_key) console.log(r.r2_key);
  process.exit(0);
}

if (cmd !== 'sql') {
  console.error('usage: import-mint.mjs sql|keys [export.json]');
  process.exit(1);
}

const out = [];
out.push('-- Backfill: the Mint line and its voicemail history.');
out.push('-- Idempotent: ids derive from the source rows, and every write is');
out.push('-- an upsert, so re-running after a partial import is safe.');
out.push(`INSERT INTO numbers (id, e164, label, serves_number, forward_to,
    greeting_mode, greeting_text, notify_email, route_token, is_active, created_at)
  VALUES ('mintline', ${q(CATCHER)}, 'Mint', ${q(SERVES)}, NULL,
    'tts', NULL, NULL, ${q(process.env.ROUTE_TOKEN || 'slq-mint-set-me')}, 1, ${Math.min(
      ...rows.map((r) => r.created_at),
    )})
  ON CONFLICT(e164) DO UPDATE SET label = excluded.label,
    serves_number = excluded.serves_number;`);

for (const r of rows) {
  const callId = id('call', r.id);
  const vmId = id('vm', r.id);
  // r2_key is namespaced on import so the two buckets' key spaces cannot
  // collide once both lines write into secondline-media.
  const key = r.r2_key ? `mint/${r.r2_key}` : null;

  out.push(`INSERT INTO calls (id, number_id, direction, peer_number, peer_name,
      peer_city, peer_state, disposition, duration_sec, twilio_sid, created_at, read_at)
    VALUES (${q(callId)}, 'mintline', 'inbound', ${q(r.from_number)}, ${q(r.from_name)},
      ${q(r.from_city)}, ${q(r.from_state)}, 'voicemail', ${n(r.duration_sec)},
      ${q(r.call_sid)}, ${n(r.created_at)}, ${r.is_read ? n(r.created_at) : 'NULL'})
    ON CONFLICT DO NOTHING;`);

  out.push(`INSERT INTO voicemails (id, call_id, number_id, from_number, duration_sec,
      r2_key, recording_sid, transcript, transcript_status, transcript_provider,
      transcript_confidence, is_read, is_saved, deleted_at, created_at)
    VALUES (${q(vmId)}, ${q(callId)}, 'mintline', ${q(r.from_number)}, ${n(r.duration_sec)},
      ${q(key)}, ${q(r.recording_sid)}, ${q(r.transcript)}, ${q(r.transcript_status || 'done')},
      ${q(r.transcript_provider)}, ${n(r.transcript_confidence)}, ${n(r.is_read) || 0},
      ${n(r.is_saved) || 0}, ${n(r.deleted_at)}, ${n(r.created_at)})
    ON CONFLICT DO NOTHING;`);
}

console.log(out.join('\n'));
console.error(`${rows.length} voicemails`);
