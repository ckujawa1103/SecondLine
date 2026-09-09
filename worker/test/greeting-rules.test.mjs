// Caller matching is a string comparison against what Twilio sends, so the
// two things that can silently break it are a number stored in the wrong shape
// and a rule-selection query that picks the wrong row. Both are tested here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { toE164 } from '../src/util.js';

test('toE164 normalises what a person would actually type', () => {
  const want = '+18152870166';
  for (const input of [
    '(815) 287-0166', '815-287-0166', '815.287.0166', '8152870166',
    '1-815-287-0166', '+1 815 287 0166', '  +18152870166  ',
  ]) {
    assert.equal(toE164(input), want, `${input} should normalise to ${want}`);
  }
});

test('toE164 rejects rather than mangles', () => {
  // A half-typed number that got stored as-is would never match a real call,
  // and would look correct in the UI while doing nothing.
  for (const input of ['', null, undefined, '555', 'call mom', '815-287']) {
    assert.equal(toE164(input), null, `${JSON.stringify(input)} should be rejected`);
  }
});

test('toE164 leaves a valid non-US number alone', () => {
  assert.equal(toE164('+442071838750'), '+442071838750');
});

/** The live rule-selection query, run against an in-memory copy of the table. */
function db() {
  const conn = new DatabaseSync(':memory:');
  conn.exec(readFileSync(new URL('../migrations/0001_greeting_rules.sql', import.meta.url), 'utf8'));
  return conn;
}

const SELECT = `
  SELECT id FROM greeting_rules
   WHERE number_id = ?1 AND caller_number = ?2 AND is_active = 1
     AND (starts_at IS NULL OR starts_at <= ?3)
     AND (ends_at   IS NULL OR ends_at   >= ?3)
   ORDER BY (starts_at IS NOT NULL OR ends_at IS NOT NULL) DESC, created_at DESC
   LIMIT 1`;

function addRule(conn, row) {
  conn.prepare(
    `INSERT INTO greeting_rules
       (id, number_id, caller_number, greeting_mode, skip_forward,
        starts_at, ends_at, is_active, created_at)
     VALUES (?, 'line', ?, 'tts', 1, ?, ?, ?, ?)`,
  ).run(row.id, row.caller, row.starts ?? null, row.ends ?? null,
        row.active ?? 1, row.created ?? 100);
}

const match = (conn, at, caller = '+15551234567') =>
  conn.prepare(SELECT).get('line', caller, at)?.id ?? null;

test('a caller with no rule falls through to the line greeting', () => {
  const conn = db();
  addRule(conn, { id: 'santa', caller: '+15551234567' });
  assert.equal(match(conn, 500, '+19995550000'), null);
});

test('a season keeps the greeting off outside its dates', () => {
  const conn = db();
  addRule(conn, { id: 'santa', caller: '+15551234567', starts: 1000, ends: 2000 });

  assert.equal(match(conn, 999), null, 'before the season');
  assert.equal(match(conn, 1000), 'santa', 'on the opening boundary');
  assert.equal(match(conn, 1500), 'santa', 'mid-season');
  assert.equal(match(conn, 2000), 'santa', 'on the closing boundary');
  assert.equal(match(conn, 2001), null, 'after the season');
});

test('a dated rule wins over a year-round one for the same caller', () => {
  const conn = db();
  // The open-ended rule is newer, so a plain "most recent wins" ordering would
  // pick it and the seasonal greeting would never play.
  addRule(conn, { id: 'santa', caller: '+15551234567', starts: 1000, ends: 2000, created: 100 });
  addRule(conn, { id: 'normal', caller: '+15551234567', created: 200 });

  assert.equal(match(conn, 1500), 'santa', 'inside the season');
  assert.equal(match(conn, 2500), 'normal', 'outside it');
});

test('turning a rule off is enough to silence it mid-season', () => {
  const conn = db();
  addRule(conn, { id: 'santa', caller: '+15551234567', starts: 1000, ends: 2000, active: 0 });
  assert.equal(match(conn, 1500), null);
});
