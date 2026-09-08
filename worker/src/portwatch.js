// Watch a number for a completed port.
//
// The problem this solves: while a line's eSIM is not installed, a port
// completing is invisible from the phone. Calls to the number reach the losing
// carrier's own voicemail rather than any forwarding you set up, and texts
// queue at the carrier undelivered — they are not merely unnotified, they have
// not been delivered to anything, so no app on any device can observe them.
//
// What is observable is the carrier of record. It changes in the national
// database at the moment of cutover, and Twilio's Lookup API reads that from
// anywhere, with no relationship to the number required. So the port is
// detected by polling a database rather than by waiting for traffic that
// cannot arrive.
//
// A lookup costs about half a cent, so hourly is roughly twelve cents a day
// and the watch removes itself once it fires.

import { now, audit, formatPhone } from './util.js';
import { notify, emailInboundMessage } from './notify.js';

const LOOKUPS = 'https://lookups.twilio.com/v2';

function lookupAuth(env) {
  const user = env.TWILIO_API_KEY || env.TWILIO_ACCOUNT_SID;
  const pass = env.TWILIO_API_KEY ? env.TWILIO_API_SECRET : env.TWILIO_AUTH_TOKEN;
  return 'Basic ' + btoa(`${user}:${pass}`);
}

async function lookup(env, e164) {
  const res = await fetch(
    `${LOOKUPS}/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
    { headers: { Authorization: lookupAuth(env) } },
  );
  if (!res.ok) throw new Error(`lookup ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const line = data.line_type_intelligence || {};
  return { carrier: line.carrier_name || null, type: line.type || null };
}

/**
 * Cron entry point. Checks every active watch and reports the first change.
 *
 * Never throws: this runs alongside the nightly housekeeping, and a lookup
 * failure must not take that down with it.
 */
export async function checkPortWatches(env) {
  if (!env.TWILIO_ACCOUNT_SID) return;

  const rows = await env.DB.prepare(
    'SELECT * FROM port_watch WHERE notified_at IS NULL',
  ).all();

  for (const row of rows.results || []) {
    try {
      const { carrier, type } = await lookup(env, row.e164);

      await env.DB.prepare(
        `UPDATE port_watch
            SET last_carrier = ?, last_type = ?, last_checked = ?, checks = checks + 1
          WHERE e164 = ?`,
      ).bind(carrier, type, now(), row.e164).run();

      // Compare against the carrier recorded when watching started, not the
      // previous check. A carrier that flaps between two names mid-port would
      // otherwise fire twice, and the question being asked is only ever
      // "has it moved from where it began".
      const carrierChanged = row.start_carrier && carrier && carrier !== row.start_carrier;
      const typeChanged = row.start_type && type && type !== row.start_type;
      if (!carrierChanged && !typeChanged) continue;

      await announce(env, row, carrier, type);

      await env.DB.prepare('UPDATE port_watch SET notified_at = ? WHERE e164 = ?')
        .bind(now(), row.e164).run();
    } catch (e) {
      await audit(env.DB, 'port_watch_failed', { e164: row.e164, error: String(e) });
    }
  }
}

async function announce(env, row, carrier, type) {
  const label = row.label || formatPhone(row.e164);
  const summary =
    `${formatPhone(row.e164)} has moved from ${row.start_carrier || 'its previous carrier'} ` +
    `to ${carrier || 'a new carrier'}.`;

  await notify(env, {
    title: `${label} has ported`,
    body: summary,
    tag: `port-${row.e164}`,
    url: '/settings',
  });

  // Email as well as push. The whole point of this watch is that the phone
  // cannot tell you, so a notification that depends on the phone being set up
  // correctly is not enough on its own.
  await emailInboundMessage(env, {
    to: row.notify_email,
    lineLabel: label,
    fromLabel: 'SecondLine',
    body:
      `${summary}\n\n` +
      `Line type is now ${type || 'unknown'}.\n\n` +
      'Next steps: install the eSIM from your carrier, then dial the conditional ' +
      'call forwarding code so unanswered calls reach SecondLine. Once the number ' +
      'is confirmed working, the old service can be cancelled.',
    threadUrl: `${(env.APP_BASE_URL || '').replace(/\/+$/, '')}/settings`,
    routeToken: null,
  }).catch((e) => audit(env.DB, 'port_watch_email_failed', String(e)));

  await audit(env.DB, 'port_detected', {
    e164: row.e164,
    from: row.start_carrier,
    to: carrier,
    checks: row.checks + 1,
  });
}

/** Start watching a number, seeding the baseline from a lookup right now. */
export async function startPortWatch(env, { e164, label, notifyEmail }) {
  const { carrier, type } = await lookup(env, e164);

  await env.DB.prepare(
    `INSERT INTO port_watch
       (e164, label, start_carrier, start_type, last_carrier, last_type,
        last_checked, checks, notify_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(e164) DO UPDATE SET
       label = excluded.label,
       start_carrier = excluded.start_carrier,
       start_type = excluded.start_type,
       last_carrier = excluded.last_carrier,
       last_type = excluded.last_type,
       last_checked = excluded.last_checked,
       notify_email = excluded.notify_email,
       notified_at = NULL`,
  ).bind(e164, label ?? null, carrier, type, carrier, type, now(), notifyEmail ?? null, now()).run();

  return { e164, carrier, type };
}
