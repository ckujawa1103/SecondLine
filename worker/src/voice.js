// Voice: inbound calls forward to a real phone and fall through to voicemail,
// outbound calls go out over WebRTC or a callback bridge.

import { now, randomToken, audit, formatPhone, clampInt } from './util.js';
import { twiml, escapeXml, fetchTwilioAsset, deleteTwilioAsset, twilioRest } from './twilio.js';
import { transcribe } from './transcribe.js';
import { notify, notifyNewVoicemail } from './notify.js';

/* ---------- inbound ---------- */

/**
 * POST /twilio/voice — a call arrived on one of our numbers.
 *
 * A caller is on the line, so this must answer fast: resolve the number, write
 * the row, return TwiML. Nothing slow happens here.
 */
export async function handleVoice(req, env, params) {
  const callSid = params.get('CallSid');
  const from = params.get('From') || 'unknown';
  const to = params.get('To');
  const base = env.APP_BASE_URL || new URL(req.url).origin;

  const number = await env.DB.prepare(
    'SELECT id, e164, label, forward_to, forward_timeout_sec, greeting_mode, greeting_text, greeting_key FROM numbers WHERE e164 = ? AND is_active = 1',
  ).bind(to).first();

  if (!number) {
    await audit(env.DB, 'inbound_call_unknown_number', { to, from });
    return twiml('<Response><Say voice="Polly.Joanna-Neural">This number is not in service.</Say><Hangup/></Response>');
  }

  if (callSid) {
    await env.DB.prepare(
      `INSERT INTO calls
         (id, number_id, direction, peer_number, peer_name, peer_city, peer_state,
          disposition, twilio_sid, created_at)
       VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'in-progress', ?, ?)
       ON CONFLICT(twilio_sid) DO NOTHING`,
    ).bind(
      randomToken(12), number.id, from,
      params.get('CallerName') || null,
      params.get('FromCity') || null,
      params.get('FromState') || null,
      callSid, now(),
    ).run();
  }

  // With a forwarding target, ring it first and only record if it goes
  // unanswered. <Dial action=...> continues to the action URL whether the call
  // was answered or not, so voicemail is decided there rather than guessed.
  if (number.forward_to) {
    const timeout = clampInt(number.forward_timeout_sec, 5, 60, 20);
    return twiml(
      `<Response>` +
        `<Dial timeout="${timeout}" callerId="${escapeXml(number.e164)}" ` +
              `action="${base}/twilio/dial" method="POST">` +
          `<Number>${escapeXml(number.forward_to)}</Number>` +
        `</Dial>` +
      `</Response>`,
    );
  }

  return twiml(`<Response>${voicemailTwiml(env, number, base)}</Response>`);
}

/**
 * POST /twilio/dial — the forwarding leg finished.
 *
 * DialCallStatus 'completed' means a human picked up and the conversation is
 * over; anything else (no-answer, busy, failed) means fall through to
 * voicemail. Without this branch, answering the call would still dump the
 * caller into voicemail afterwards.
 */
export async function handleDial(req, env, params) {
  const status = params.get('DialCallStatus');
  const to = params.get('To');
  const callSid = params.get('CallSid');
  const base = env.APP_BASE_URL || new URL(req.url).origin;

  if (status === 'completed') {
    await env.DB.prepare(
      `UPDATE calls SET disposition = 'answered', duration_sec = ?, read_at = ?
        WHERE twilio_sid = ?`,
    ).bind(parseInt(params.get('DialCallDuration') || '0', 10), now(), callSid).run();
    return twiml('<Response><Hangup/></Response>');
  }

  const number = await env.DB.prepare(
    'SELECT id, e164, greeting_mode, greeting_text, greeting_key FROM numbers WHERE e164 = ?',
  ).bind(to).first();

  if (!number) return twiml('<Response><Hangup/></Response>');
  return twiml(`<Response>${voicemailTwiml(env, number, base)}</Response>`);
}

function voicemailTwiml(env, number, base) {
  // A recorded greeting wins over text-to-speech. Driven by a column rather
  // than an R2 lookup so the call path stays fast — a caller is waiting.
  const greeting = number.greeting_mode === 'audio' && number.greeting_key
    ? `<Play>${base}/api/greeting/${encodeURIComponent(number.id)}</Play>`
    : `<Say voice="Polly.Joanna-Neural">${escapeXml(
        number.greeting_text || "Please leave a message after the tone.",
      )}</Say>`;

  const maxLength = clampInt(env.MAX_RECORDING_SEC, 30, 600, 180);

  return (
    greeting +
    `<Record maxLength="${maxLength}" timeout="5" playBeep="true" trim="trim-silence" ` +
      `recordingStatusCallback="${base}/twilio/recording" ` +
      `recordingStatusCallbackEvent="completed" method="POST" />` +
    // Reached only if the caller hung up without recording.
    `<Hangup/>`
  );
}

/* ---------- recording ---------- */

/**
 * POST /twilio/recording — voicemail audio is ready.
 *
 * Returns immediately and does the slow work (download, store, transcribe,
 * notify) in waitUntil, so Twilio never sees a timeout.
 */
export async function handleRecording(req, env, params, ctx) {
  const callSid = params.get('CallSid');
  const recordingSid = params.get('RecordingSid');
  const recordingUrl = params.get('RecordingUrl');
  const duration = parseInt(params.get('RecordingDuration') || '0', 10);

  if (!callSid || !recordingUrl) return new Response('', { status: 204 });

  // Hang-ups and dial-tone blips are not voicemails. Mark the call missed and
  // record nothing — carried over from Mint Voicemail, where these were most
  // of the noise in the inbox.
  if (duration < 2) {
    await env.DB.prepare(
      `UPDATE calls SET disposition = 'missed' WHERE twilio_sid = ? AND disposition = 'in-progress'`,
    ).bind(callSid).run();
    return new Response('', { status: 204 });
  }

  ctx.waitUntil(ingestRecording(env, { callSid, recordingSid, recordingUrl, duration }));
  return new Response('', { status: 204 });
}

async function ingestRecording(env, { callSid, recordingSid, recordingUrl, duration }) {
  try {
    const call = await env.DB.prepare(
      'SELECT id, number_id, peer_number, peer_name, contact_id FROM calls WHERE twilio_sid = ?',
    ).bind(callSid).first();
    if (!call) return;

    const existing = await env.DB.prepare(
      'SELECT id FROM voicemails WHERE call_id = ?',
    ).bind(call.id).first();
    if (existing) return; // Twilio retried

    const asset = await fetchTwilioAsset(env, `${recordingUrl}.mp3`);
    if (!asset) {
      await audit(env.DB, 'recording_fetch_failed', { callSid });
      return;
    }

    const vmId = randomToken(12);
    const key = `vm/${vmId}.mp3`;
    await env.MEDIA.put(key, asset.body, { httpMetadata: { contentType: 'audio/mpeg' } });

    await env.DB.prepare(
      `INSERT INTO voicemails
         (id, call_id, number_id, from_number, contact_id, duration_sec,
          r2_key, recording_sid, transcript_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(
      vmId, call.id, call.number_id, call.peer_number, call.contact_id ?? null,
      duration, key, recordingSid, now(),
    ).run();

    await env.DB.prepare(
      `UPDATE calls SET disposition = 'voicemail', duration_sec = ? WHERE id = ?`,
    ).bind(duration, call.id).run();

    // Transcription failure must not lose the voicemail — the audio is already
    // safe in R2 and the UI offers a retry.
    let transcript = null;
    try {
      const result = await transcribe(env, asset.body);
      transcript = result.text;
      await env.DB.prepare(
        `UPDATE voicemails
            SET transcript = ?, transcript_status = 'done',
                transcript_provider = ?, transcript_confidence = ?
          WHERE id = ?`,
      ).bind(result.text, result.provider, result.confidence ?? null, vmId).run();
    } catch (e) {
      await env.DB.prepare(
        "UPDATE voicemails SET transcript_status = 'failed' WHERE id = ?",
      ).bind(vmId).run();
      await audit(env.DB, 'transcribe_failed', { vmId, error: String(e) });
    }

    if (recordingSid) await deleteTwilioAsset(env, `/Recordings/${recordingSid}.json`);

    const label = await contactLabel(env, call.peer_number, call.peer_name);

    // Which line took the call decides where the transcript is emailed. A
    // personal line and a business line route to different inboxes, so the
    // recipient is a property of the number, not of the account.
    const line = await env.DB.prepare(
      'SELECT label, notify_email, route_token FROM numbers WHERE id = ?',
    ).bind(call.number_id).first();

    await notifyNewVoicemail(env, {
      id: vmId,
      from: call.peer_number,
      fromLabel: label,
      duration,
      transcript,
      notifyEmail: line?.notify_email || null,
      lineLabel: line?.label || null,
      routeToken: line?.route_token || null,
    });
  } catch (e) {
    await audit(env.DB, 'ingest_failed', { callSid, error: String(e) });
  }
}

/* ---------- call status ---------- */

/** POST /twilio/call-status — final disposition for calls we placed. */
export async function handleCallStatus(env, params) {
  const sid = params.get('CallSid');
  const status = params.get('CallStatus');
  if (!sid || !status) return new Response('', { status: 204 });

  const map = {
    completed: 'answered', busy: 'busy', 'no-answer': 'missed',
    failed: 'failed', canceled: 'missed',
  };

  await env.DB.prepare(
    'UPDATE calls SET disposition = ?, duration_sec = ? WHERE twilio_sid = ?',
  ).bind(
    map[status] || status,
    parseInt(params.get('CallDuration') || '0', 10),
    sid,
  ).run();

  return new Response('', { status: 204 });
}

/* ---------- outbound ---------- */

/**
 * Callback bridge: Twilio rings your phone, then dials the recipient with the
 * project number as caller ID.
 *
 * The fallback for when a browser microphone is not an option. It costs two
 * legs instead of one and takes a few seconds longer to connect, which is why
 * the WebRTC dialer is the default.
 */
export async function placeBridgedCall(env, { numberId, to, bridgeTo }) {
  const number = await env.DB.prepare(
    'SELECT id, e164 FROM numbers WHERE id = ? AND is_active = 1',
  ).bind(numberId).first();
  if (!number) throw Object.assign(new Error('Unknown number'), { status: 404 });

  const base = env.APP_BASE_URL;

  // Leg one rings you. When you answer, the TwiML returned by /api/bridge
  // dials the recipient and joins the two.
  const call = await twilioRest(env, 'POST', '/Calls.json', {
    To: bridgeTo,
    From: number.e164,
    Url: `${base}/api/bridge?to=${encodeURIComponent(to)}&from=${encodeURIComponent(number.e164)}`,
    StatusCallback: `${base}/twilio/call-status`,
  });

  await env.DB.prepare(
    `INSERT INTO calls (id, number_id, direction, peer_number, disposition, twilio_sid, created_at)
     VALUES (?, ?, 'outbound', ?, 'in-progress', ?, ?)`,
  ).bind(randomToken(12), number.id, to, call.sid, now()).run();

  return { sid: call.sid };
}

async function contactLabel(env, number, fallbackName) {
  const known = await env.DB.prepare(
    `SELECT c.name FROM contact_numbers cn JOIN contacts c ON c.id = cn.contact_id
      WHERE cn.number = ?`,
  ).bind(number).first();
  return known?.name || fallbackName || formatPhone(number);
}
