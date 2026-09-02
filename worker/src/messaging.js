// SMS and MMS: inbound webhook, outbound send, delivery status.

import { now, randomToken, audit, formatPhone } from './util.js';
import { twilioRest, fetchTwilioAsset, deleteTwilioAsset } from './twilio.js';
import { notify } from './notify.js';

/* ---------- inbound ---------- */

/**
 * POST /twilio/message — someone texted one of our numbers.
 *
 * Twilio waits on this response, so it does the minimum inline (resolve the
 * number, write the row, bump the thread) and defers media download and push
 * notification to waitUntil.
 */
export async function handleInboundMessage(req, env, params, ctx) {
  const messageSid = params.get('MessageSid') || params.get('SmsSid');
  const from = params.get('From');
  const to = params.get('To');
  const body = params.get('Body') || '';
  const numMedia = parseInt(params.get('NumMedia') || '0', 10);

  if (!messageSid || !from || !to) return emptyTwiml();

  const number = await env.DB.prepare(
    'SELECT id, e164, label FROM numbers WHERE e164 = ? AND is_active = 1',
  ).bind(to).first();

  // A message to a number we no longer own is not an error worth failing on —
  // it happens between releasing a number and Twilio dropping the webhook.
  if (!number) {
    await audit(env.DB, 'inbound_unknown_number', { to, from });
    return emptyTwiml();
  }

  const thread = await upsertThread(env, number.id, from);

  // Blocked threads still record the message so nothing silently vanishes,
  // but they do not notify and do not count as unread.
  const blocked = thread.is_blocked === 1;

  const messageId = randomToken(12);
  const ts = now();

  // ON CONFLICT: Twilio retries webhooks, and a duplicate must not create a
  // second message row for the same SID.
  const inserted = await env.DB.prepare(
    `INSERT INTO messages
       (id, thread_id, number_id, direction, peer_number, body, status,
        twilio_sid, num_media, created_at, read_at)
     VALUES (?, ?, ?, 'inbound', ?, ?, 'received', ?, ?, ?, ?)
     ON CONFLICT(twilio_sid) DO NOTHING`,
  ).bind(
    messageId, thread.id, number.id, from, body, messageSid,
    numMedia, ts, blocked ? ts : null,
  ).run();

  // meta.changes === 0 means this was a retry we have already handled.
  if (!inserted.meta?.changes) return emptyTwiml();

  await env.DB.prepare(
    `UPDATE threads
        SET last_message_at = ?, last_preview = ?,
            unread_count = unread_count + ?, is_archived = 0
      WHERE id = ?`,
  ).bind(ts, preview(body, numMedia), blocked ? 0 : 1, thread.id).run();

  if (numMedia > 0) {
    ctx.waitUntil(ingestMedia(env, messageId, params, numMedia));
  }

  if (!blocked) {
    ctx.waitUntil(notify(env, {
      title: thread.contact_name || formatPhone(from),
      body: body || (numMedia ? `${numMedia} attachment${numMedia > 1 ? 's' : ''}` : ''),
      tag: `thread-${thread.id}`,
      url: `/messages/${thread.id}`,
    }));
  }

  // Empty TwiML: acknowledge without auto-replying. Anything else here would
  // send a real text to whoever wrote in.
  return emptyTwiml();
}

/**
 * Pull MMS attachments into R2 and drop Twilio's copies.
 *
 * Same reasoning as the voicemail audio in Mint Voicemail: Twilio charges to
 * store them, and a picture someone sent should live in exactly one place you
 * control. Twilio's copy is public-by-URL until deleted, which is the stronger
 * argument of the two.
 */
async function ingestMedia(env, messageId, params, numMedia) {
  for (let i = 0; i < numMedia; i++) {
    const url = params.get(`MediaUrl${i}`);
    const declaredType = params.get(`MediaContentType${i}`) || 'application/octet-stream';
    if (!url) continue;

    try {
      const asset = await fetchTwilioAsset(env, url);
      if (!asset) continue;

      const ext = extensionFor(declaredType);
      const key = `mms/${messageId}/${i}${ext}`;

      await env.MEDIA.put(key, asset.body, {
        httpMetadata: { contentType: declaredType },
      });

      await env.DB.prepare(
        `INSERT INTO media (id, message_id, r2_key, content_type, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(randomToken(10), messageId, key, declaredType, asset.body.byteLength, now()).run();

      // The media SID is the last path segment of the media URL.
      const mediaSid = url.split('/').pop();
      const msgSid = url.split('/Messages/')[1]?.split('/')[0];
      if (mediaSid && msgSid) {
        await deleteTwilioAsset(env, `/Messages/${msgSid}/Media/${mediaSid}.json`);
      }
    } catch (e) {
      await audit(env.DB, 'media_ingest_failed', { messageId, index: i, error: String(e) });
    }
  }
}

/* ---------- outbound ---------- */

/**
 * Send a text from one of our numbers.
 *
 * Writes the row first with status 'queued', then calls Twilio, so a message
 * is never lost to a failed API call — it shows as failed in the thread
 * instead of disappearing.
 */
export async function sendMessage(env, { numberId, to, body, mediaUrls = [] }) {
  const number = await env.DB.prepare(
    'SELECT id, e164, messaging_service_sid FROM numbers WHERE id = ? AND is_active = 1',
  ).bind(numberId).first();
  if (!number) throw Object.assign(new Error('Unknown number'), { status: 404 });

  const thread = await upsertThread(env, number.id, to);
  const messageId = randomToken(12);
  const ts = now();

  await env.DB.prepare(
    `INSERT INTO messages
       (id, thread_id, number_id, direction, peer_number, body, status,
        num_media, created_at, read_at)
     VALUES (?, ?, ?, 'outbound', ?, ?, 'queued', ?, ?, ?)`,
  ).bind(messageId, thread.id, number.id, to, body, mediaUrls.length, ts, ts).run();

  await env.DB.prepare(
    `UPDATE threads SET last_message_at = ?, last_preview = ?, is_archived = 0 WHERE id = ?`,
  ).bind(ts, preview(body, mediaUrls.length), thread.id).run();

  const form = {
    To: to,
    Body: body || '',
    StatusCallback: `${env.APP_BASE_URL}/twilio/message-status`,
  };

  // A Messaging Service carries the A2P campaign registration, so send through
  // it when one is configured and fall back to the bare number otherwise —
  // during setup, before 10DLC approval, there is no service yet.
  if (number.messaging_service_sid) {
    form.MessagingServiceSid = number.messaging_service_sid;
  } else {
    form.From = number.e164;
  }
  for (const url of mediaUrls) form.MediaUrl = url;

  try {
    const sent = await twilioRest(env, 'POST', '/Messages.json', form);
    await env.DB.prepare(
      'UPDATE messages SET twilio_sid = ?, status = ? WHERE id = ?',
    ).bind(sent.sid, sent.status || 'sent', messageId).run();
    return { id: messageId, threadId: thread.id, status: sent.status };
  } catch (e) {
    await env.DB.prepare(
      'UPDATE messages SET status = ?, error_code = ? WHERE id = ?',
    ).bind('failed', e.code ?? null, messageId).run();
    await audit(env.DB, 'send_failed', { to, error: String(e), code: e.code });
    throw e;
  }
}

/**
 * POST /twilio/message-status — delivery receipt.
 *
 * Error 30034 is unregistered 10DLC and 30007 is carrier filtering. Both mean
 * the message was accepted by Twilio and then dropped by a carrier, which is
 * invisible without this callback.
 */
export async function handleMessageStatus(env, params) {
  const sid = params.get('MessageSid') || params.get('SmsSid');
  const status = params.get('MessageStatus') || params.get('SmsStatus');
  const errorCode = params.get('ErrorCode');
  if (!sid || !status) return new Response('', { status: 204 });

  await env.DB.prepare(
    'UPDATE messages SET status = ?, error_code = ? WHERE twilio_sid = ?',
  ).bind(status, errorCode ? parseInt(errorCode, 10) : null, sid).run();

  if (errorCode) {
    await audit(env.DB, 'message_delivery_error', { sid, status, errorCode });
  }
  return new Response('', { status: 204 });
}

/* ---------- helpers ---------- */

/**
 * Find or create the thread for (our number, their number).
 *
 * Threads are per-pair rather than per-person: the same contact texting two of
 * our numbers is two threads, because a reply has to go back out from the
 * number they actually contacted.
 */
async function upsertThread(env, numberId, peerNumber) {
  const existing = await env.DB.prepare(
    `SELECT t.id, t.is_blocked, t.contact_id, c.name AS contact_name
       FROM threads t
       LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.number_id = ? AND t.peer_number = ?`,
  ).bind(numberId, peerNumber).first();
  if (existing) return existing;

  // Attach a known contact on creation so the first notification can name them.
  const known = await env.DB.prepare(
    `SELECT c.id, c.name FROM contact_numbers cn
       JOIN contacts c ON c.id = cn.contact_id
      WHERE cn.number = ?`,
  ).bind(peerNumber).first();

  const id = randomToken(12);
  await env.DB.prepare(
    `INSERT INTO threads (id, number_id, peer_number, contact_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(number_id, peer_number) DO NOTHING`,
  ).bind(id, numberId, peerNumber, known?.id ?? null, now()).run();

  // Re-read rather than trusting the insert: a concurrent inbound message for
  // the same pair may have won the race, in which case its id is the real one.
  return env.DB.prepare(
    `SELECT t.id, t.is_blocked, t.contact_id, c.name AS contact_name
       FROM threads t
       LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.number_id = ? AND t.peer_number = ?`,
  ).bind(numberId, peerNumber).first();
}

function preview(body, numMedia) {
  const text = (body || '').trim().replace(/\s+/g, ' ').slice(0, 140);
  if (text) return text;
  return numMedia ? `${numMedia} attachment${numMedia > 1 ? 's' : ''}` : '';
}

function extensionFor(contentType) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/heic': '.heic',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/3gpp': '.3gp',
    'audio/mpeg': '.mp3', 'audio/amr': '.amr', 'audio/ogg': '.ogg',
    'application/pdf': '.pdf', 'text/vcard': '.vcf',
  };
  return map[contentType] || '';
}

function emptyTwiml() {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}
