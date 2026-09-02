// The app's data API. Everything here is behind a session except the two
// routes Twilio itself fetches, which are called out where they appear.

import {
  now, randomToken, audit, json, err, clampInt,
  b64urlEncode, timingSafeEqual,
} from './util.js';
import { requireSession } from './auth.js';
import { sendMessage } from './messaging.js';
import { placeBridgedCall } from './voice.js';
import { twiml, escapeXml, verifyTwilioSignature } from './twilio.js';
import { pushPublicKey } from './notify.js';

// Long enough for a listening session without becoming a durable credential.
const MEDIA_TOKEN_TTL = 6 * 3600;

export async function handleApi(req, env, path, ctx) {
  const url = new URL(req.url);

  /* ---- routes Twilio fetches, not the browser ---- */

  // Outgoing greeting. Deliberately unauthenticated: Twilio fetches this
  // anonymously while a caller is on the line, and it is the message every
  // caller already hears.
  const greetingMatch = /^\/api\/greeting\/([\w-]+)$/.exec(path);
  if (greetingMatch && req.method === 'GET') {
    return streamGreeting(env, greetingMatch[1]);
  }

  // Second leg of the callback bridge. Twilio POSTs here when you pick up, and
  // the TwiML it gets back dials the person you are calling. Signature-checked
  // because it can originate a billable call.
  if (path === '/api/bridge' && req.method === 'POST') {
    const params = new URLSearchParams(await req.text());
    if (!(await verifyTwilioSignature(req, env, params))) {
      await audit(env.DB, 'bridge_signature_rejected', {}, req);
      return new Response('Forbidden', { status: 403 });
    }
    const to = url.searchParams.get('to');
    const from = url.searchParams.get('from');
    if (!to || !from) return twiml('<Response><Hangup/></Response>');
    return twiml(
      `<Response><Dial callerId="${escapeXml(from)}" answerOnBridge="true">` +
        `<Number>${escapeXml(to)}</Number></Dial></Response>`,
    );
  }

  // Media and voicemail audio are fetched by <img> and <audio> elements, which
  // cannot attach an Authorization header. They authenticate with a
  // short-lived token scoped to the single object instead.
  const mediaMatch = /^\/api\/media\/([\w-]+)$/.exec(path);
  if (mediaMatch && req.method === 'GET') {
    return streamMedia(req, env, mediaMatch[1], url.searchParams.get('t'));
  }

  const vmAudioMatch = /^\/api\/voicemails\/([\w-]+)\/audio$/.exec(path);
  if (vmAudioMatch && req.method === 'GET') {
    return streamVoicemail(req, env, vmAudioMatch[1], url.searchParams.get('t'));
  }

  /* ---- everything below requires a session ---- */

  const session = await requireSession(req, env);
  if (!session) return err('Unauthorized', 401);

  /* ---- numbers ---- */

  if (path === '/api/numbers' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT n.id, n.e164, n.label, n.forward_to, n.forward_timeout_sec,
              n.greeting_mode, n.greeting_text, n.messaging_service_sid,
              n.campaign_sid, n.is_active,
              (SELECT COUNT(*) FROM threads t
                WHERE t.number_id = n.id AND t.unread_count > 0) AS unread_threads
         FROM numbers n
        ORDER BY n.created_at ASC`,
    ).all();
    return json({ numbers: rows.results || [] });
  }

  const numberMatch = /^\/api\/numbers\/([\w-]+)$/.exec(path);
  if (numberMatch && req.method === 'PATCH') {
    const id = numberMatch[1];
    const patch = await req.json().catch(() => ({}));

    // Whitelist: a PATCH must never be able to reassign twilio_sid or
    // campaign_sid, which would silently point a line at another account's
    // number or another brand's campaign.
    const allowed = ['label', 'forward_to', 'forward_timeout_sec', 'greeting_mode',
                     'greeting_text', 'is_active'];
    const sets = [];
    const binds = [];
    for (const key of allowed) {
      if (key in patch) { sets.push(`${key} = ?`); binds.push(patch[key]); }
    }
    if (!sets.length) return err('Nothing to update', 400);

    binds.push(id);
    await env.DB.prepare(`UPDATE numbers SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    await audit(env.DB, 'number_updated', { id, fields: Object.keys(patch) }, req);
    return json({ ok: true });
  }

  /* ---- threads ---- */

  if (path === '/api/threads' && req.method === 'GET') {
    const numberId = url.searchParams.get('number');
    const archived = url.searchParams.get('archived') === '1' ? 1 : 0;
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);

    const rows = await env.DB.prepare(
      `SELECT t.id, t.number_id, t.peer_number, t.last_message_at, t.last_preview,
              t.unread_count, t.is_archived, t.is_blocked,
              c.name AS contact_name, n.e164 AS number_e164, n.label AS number_label
         FROM threads t
         LEFT JOIN contacts c ON c.id = t.contact_id
         JOIN numbers n ON n.id = t.number_id
        WHERE t.is_archived = ?1
          AND (?2 IS NULL OR t.number_id = ?2)
        ORDER BY t.last_message_at DESC NULLS LAST
        LIMIT ?3`,
    ).bind(archived, numberId || null, limit).all();

    return json({ threads: rows.results || [] });
  }

  const threadMatch = /^\/api\/threads\/([\w-]+)(\/[a-z]+)?$/.exec(path);
  if (threadMatch) {
    const id = threadMatch[1];
    const action = threadMatch[2];

    if (req.method === 'GET' && !action) {
      const thread = await env.DB.prepare(
        `SELECT t.*, c.name AS contact_name, n.e164 AS number_e164
           FROM threads t
           LEFT JOIN contacts c ON c.id = t.contact_id
           JOIN numbers n ON n.id = t.number_id
          WHERE t.id = ?`,
      ).bind(id).first();
      if (!thread) return err('Not found', 404);

      const before = url.searchParams.get('before');
      const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);

      const messages = await env.DB.prepare(
        `SELECT id, direction, body, status, error_code, num_media, created_at, read_at
           FROM messages
          WHERE thread_id = ?1 AND (?2 IS NULL OR created_at < ?2)
          ORDER BY created_at DESC
          LIMIT ?3`,
      ).bind(id, before ? parseInt(before, 10) : null, limit).all();

      // Attach media with signed URLs, one query rather than one per message.
      const withMedia = (messages.results || []).filter((m) => m.num_media > 0);
      if (withMedia.length) {
        const ids = withMedia.map((m) => m.id);
        const media = await env.DB.prepare(
          `SELECT id, message_id, content_type FROM media
            WHERE message_id IN (${ids.map(() => '?').join(',')})`,
        ).bind(...ids).all();

        const byMessage = new Map();
        for (const m of media.results || []) {
          const token = await signMediaToken(env, m.id);
          const list = byMessage.get(m.message_id) || [];
          list.push({ id: m.id, contentType: m.content_type, url: `/api/media/${m.id}?t=${token}` });
          byMessage.set(m.message_id, list);
        }
        for (const msg of messages.results) msg.media = byMessage.get(msg.id) || [];
      }

      return json({ thread, messages: (messages.results || []).reverse() });
    }

    if (action === '/read' && req.method === 'POST') {
      const t = now();
      await env.DB.batch([
        env.DB.prepare('UPDATE messages SET read_at = ? WHERE thread_id = ? AND read_at IS NULL')
          .bind(t, id),
        env.DB.prepare('UPDATE threads SET unread_count = 0 WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }

    if (action === '/send' && req.method === 'POST') {
      const { body, mediaUrls } = await req.json().catch(() => ({}));
      const thread = await env.DB.prepare(
        'SELECT number_id, peer_number FROM threads WHERE id = ?',
      ).bind(id).first();
      if (!thread) return err('Not found', 404);
      if (!body && !mediaUrls?.length) return err('Nothing to send', 400);

      try {
        const result = await sendMessage(env, {
          numberId: thread.number_id,
          to: thread.peer_number,
          body,
          mediaUrls,
        });
        return json(result);
      } catch (e) {
        // 30034 is the unregistered-10DLC rejection. Saying so plainly beats a
        // generic failure, because the fix is registration, not retrying.
        const hint = e.code === 30034
          ? 'The number is not attached to an approved A2P campaign yet.'
          : undefined;
        return err(hint || e.message || 'Send failed', e.status || 502);
      }
    }

    if (req.method === 'PATCH' && !action) {
      const patch = await req.json().catch(() => ({}));
      const sets = [];
      const binds = [];
      for (const key of ['is_archived', 'is_blocked', 'contact_id']) {
        if (key in patch) { sets.push(`${key} = ?`); binds.push(patch[key]); }
      }
      if (!sets.length) return err('Nothing to update', 400);
      binds.push(id);
      await env.DB.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...binds).run();
      return json({ ok: true });
    }
  }

  // Start a new conversation from a number we own.
  if (path === '/api/send' && req.method === 'POST') {
    const { numberId, to, body, mediaUrls } = await req.json().catch(() => ({}));
    if (!numberId || !to) return err('numberId and to are required', 400);
    try {
      return json(await sendMessage(env, { numberId, to, body, mediaUrls }));
    } catch (e) {
      return err(e.message || 'Send failed', e.status || 502);
    }
  }

  /* ---- calls ---- */

  if (path === '/api/calls' && req.method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
    const rows = await env.DB.prepare(
      `SELECT c.id, c.number_id, c.direction, c.peer_number, c.peer_name,
              c.peer_city, c.peer_state, c.disposition, c.duration_sec,
              c.created_at, c.read_at,
              ct.name AS contact_name, n.e164 AS number_e164,
              v.id AS voicemail_id
         FROM calls c
         LEFT JOIN contacts ct ON ct.id = c.contact_id
         LEFT JOIN voicemails v ON v.call_id = c.id AND v.deleted_at IS NULL
         JOIN numbers n ON n.id = c.number_id
        ORDER BY c.created_at DESC
        LIMIT ?`,
    ).bind(limit).all();
    return json({ calls: rows.results || [] });
  }

  // Callback bridge: Twilio rings your phone, then dials out.
  if (path === '/api/calls/bridge' && req.method === 'POST') {
    const { numberId, to, bridgeTo } = await req.json().catch(() => ({}));
    if (!numberId || !to || !bridgeTo) {
      return err('numberId, to and bridgeTo are required', 400);
    }
    try {
      const result = await placeBridgedCall(env, { numberId, to, bridgeTo });
      await audit(env.DB, 'bridge_call_placed', { to }, req);
      return json(result);
    } catch (e) {
      return err(e.message || 'Call failed', e.status || 502);
    }
  }

  // Access token for the in-app WebRTC dialer.
  //
  // Twilio's Voice SDK wants a short-lived JWT rather than account
  // credentials, which is the point: the browser never holds anything that
  // outlives the tab. Requires an API key — the account auth token cannot sign
  // these.
  if (path === '/api/voice/token' && req.method === 'POST') {
    if (!env.TWILIO_API_KEY || !env.TWILIO_API_SECRET || !env.TWILIO_TWIML_APP_SID) {
      return err('Dialer not configured: needs TWILIO_API_KEY, TWILIO_API_SECRET and TWILIO_TWIML_APP_SID', 503);
    }
    const token = await voiceAccessToken(env);
    return json({ token, expiresIn: VOICE_TOKEN_TTL });
  }

  /* ---- voicemail ---- */

  if (path === '/api/voicemails' && req.method === 'GET') {
    const trash = url.searchParams.get('trash') === '1';
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);

    const rows = await env.DB.prepare(
      `SELECT v.id, v.number_id, v.from_number, v.duration_sec, v.transcript,
              v.transcript_status, v.transcript_confidence, v.is_read, v.is_saved,
              v.created_at, c.name AS contact_name, n.e164 AS number_e164
         FROM voicemails v
         LEFT JOIN contacts c ON c.id = v.contact_id
         JOIN numbers n ON n.id = v.number_id
        WHERE v.deleted_at IS ${trash ? 'NOT NULL' : 'NULL'}
        ORDER BY v.created_at DESC
        LIMIT ?`,
    ).bind(limit).all();

    for (const r of rows.results || []) {
      r.audioUrl = `/api/voicemails/${r.id}/audio?t=${await signMediaToken(env, r.id)}`;
    }
    return json({ voicemails: rows.results || [] });
  }

  const vmMatch = /^\/api\/voicemails\/([\w-]+)(\/[a-z]+)?$/.exec(path);
  if (vmMatch) {
    const id = vmMatch[1];
    const action = vmMatch[2];

    if (req.method === 'PATCH' && !action) {
      const patch = await req.json().catch(() => ({}));
      const sets = [];
      const binds = [];
      for (const key of ['is_read', 'is_saved']) {
        if (key in patch) { sets.push(`${key} = ?`); binds.push(patch[key] ? 1 : 0); }
      }
      if (!sets.length) return err('Nothing to update', 400);
      binds.push(id);
      await env.DB.prepare(`UPDATE voicemails SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...binds).run();
      return json({ ok: true });
    }

    // Soft delete: recoverable until the nightly purge takes it.
    if (req.method === 'DELETE' && !action) {
      await env.DB.prepare('UPDATE voicemails SET deleted_at = ? WHERE id = ?')
        .bind(now(), id).run();
      return json({ ok: true });
    }

    if (action === '/restore' && req.method === 'POST') {
      await env.DB.prepare('UPDATE voicemails SET deleted_at = NULL WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  /* ---- contacts ---- */

  if (path === '/api/contacts' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.name, c.note,
              (SELECT GROUP_CONCAT(number) FROM contact_numbers WHERE contact_id = c.id) AS numbers
         FROM contacts c ORDER BY c.name COLLATE NOCASE`,
    ).all();
    return json({ contacts: rows.results || [] });
  }

  if (path === '/api/contacts' && req.method === 'POST') {
    const { name, note, numbers = [] } = await req.json().catch(() => ({}));
    if (!name) return err('name is required', 400);

    const id = randomToken(10);
    const statements = [
      env.DB.prepare('INSERT INTO contacts (id, name, note, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, name, note ?? null, now()),
    ];
    for (const n of numbers) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO contact_numbers (number, contact_id, created_at) VALUES (?, ?, ?)
           ON CONFLICT(number) DO UPDATE SET contact_id = excluded.contact_id`,
        ).bind(n, id, now()),
        // Backfill: attach existing threads for this number to the new contact
        // so history joins up rather than starting fresh.
        env.DB.prepare('UPDATE threads SET contact_id = ? WHERE peer_number = ?').bind(id, n),
        env.DB.prepare('UPDATE calls SET contact_id = ? WHERE peer_number = ?').bind(id, n),
      );
    }
    await env.DB.batch(statements);
    return json({ id });
  }

  /* ---- push ---- */

  if (path === '/api/push/key' && req.method === 'GET') {
    return json({ key: pushPublicKey(env) });
  }

  if (path === '/api/push/subscribe' && req.method === 'POST') {
    const { endpoint, keys } = await req.json().catch(() => ({}));
    if (!endpoint || !keys?.p256dh || !keys?.auth) return err('Invalid subscription', 400);
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO NOTHING`,
    ).bind(endpoint, keys.p256dh, keys.auth, now()).run();
    return json({ ok: true });
  }

  if (path === '/api/push/unsubscribe' && req.method === 'POST') {
    const { endpoint } = await req.json().catch(() => ({}));
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
      .bind(endpoint).run();
    return json({ ok: true });
  }

  return err('Not found', 404);
}

/* ---------- Voice SDK access token ---------- */

const VOICE_TOKEN_TTL = 3600;

/**
 * Twilio access token: a JWT signed with the API key secret.
 *
 * The `cty: twilio-fpa;v=1` header is not decoration — the SDK rejects tokens
 * without it. `identity` is the single user, since this app has exactly one.
 */
async function voiceAccessToken(env) {
  const iat = now();
  const exp = iat + VOICE_TOKEN_TTL;

  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${env.TWILIO_API_KEY}-${iat}`,
    iss: env.TWILIO_API_KEY,
    sub: env.TWILIO_ACCOUNT_SID,
    iat,
    exp,
    grants: {
      identity: 'owner',
      voice: {
        outgoing: { application_sid: env.TWILIO_TWIML_APP_SID },
        incoming: { allow: true },
      },
    },
  };

  const encode = (obj) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${encode(header)}.${encode(payload)}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TWILIO_API_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${b64urlEncode(sig)}`;
}

/* ---------- signed media access ---------- */

/**
 * HMAC over "id.expiry" using SESSION_SECRET, scoped to one object and
 * time-limited, so a media URL that leaks cannot be replayed or widened into
 * access to anything else.
 */
async function signMediaToken(env, id) {
  const exp = now() + MEDIA_TOKEN_TTL;
  return `${exp}.${await hmacB64(env.SESSION_SECRET, `${id}.${exp}`)}`;
}

async function verifyMediaToken(env, id, token) {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = parseInt(expStr, 10);
  if (!exp || exp < now()) return false;
  return timingSafeEqual(sig || '', await hmacB64(env.SESSION_SECRET, `${id}.${exp}`));
}

async function hmacB64(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64urlEncode(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

async function streamMedia(req, env, id, token) {
  if (!(await verifyMediaToken(env, id, token))) return new Response('Forbidden', { status: 403 });

  const row = await env.DB.prepare(
    'SELECT r2_key, content_type FROM media WHERE id = ?',
  ).bind(id).first();
  if (!row?.r2_key) return new Response('Not found', { status: 404 });

  const object = await env.MEDIA.get(row.r2_key);
  if (!object) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      // Media arrives from strangers. Never let the browser execute it as a
      // document on our own origin.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    },
  });
}

async function streamVoicemail(req, env, id, token) {
  if (!(await verifyMediaToken(env, id, token))) return new Response('Forbidden', { status: 403 });

  const row = await env.DB.prepare('SELECT r2_key FROM voicemails WHERE id = ?').bind(id).first();
  if (!row?.r2_key) return new Response('Not found', { status: 404 });

  // Honour Range so scrubbing in the audio player works.
  const range = req.headers.get('Range');
  const parsed = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

  const object = await env.MEDIA.get(row.r2_key, parsed ? {
    range: {
      offset: parsed[1] ? parseInt(parsed[1], 10) : undefined,
      length: parsed[2]
        ? parseInt(parsed[2], 10) - parseInt(parsed[1] || '0', 10) + 1
        : undefined,
    },
  } : undefined);

  if (!object) return new Response('Not found', { status: 404 });

  const headers = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };

  if (object.range && object.size !== undefined) {
    const start = object.range.offset ?? 0;
    const end = start + (object.range.length ?? object.size) - 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${object.size}`;
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}

async function streamGreeting(env, numberId) {
  const row = await env.DB.prepare(
    'SELECT greeting_key FROM numbers WHERE id = ?',
  ).bind(numberId).first();
  if (!row?.greeting_key) return new Response('No greeting', { status: 404 });

  const object = await env.MEDIA.get(row.greeting_key);
  if (!object) return new Response('No greeting', { status: 404 });

  return new Response(object.body, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=300' },
  });
}

/* ---------- housekeeping ---------- */

export async function purgeTrash(env) {
  const days = clampInt(env.TRASH_RETENTION_DAYS, 1, 365, 30);
  const cutoff = now() - days * 86400;

  // Saved voicemails are exempt: the point of saving one is that it survives.
  const doomed = await env.DB.prepare(
    'SELECT id, r2_key FROM voicemails WHERE deleted_at IS NOT NULL AND deleted_at < ? AND is_saved = 0',
  ).bind(cutoff).all();

  for (const row of doomed.results || []) {
    if (row.r2_key) await env.MEDIA.delete(row.r2_key).catch(() => {});
    await env.DB.prepare('DELETE FROM voicemails WHERE id = ?').bind(row.id).run();
  }
}
