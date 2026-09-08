// SecondLine — Cloudflare Worker entrypoint.
//
// Four surfaces:
//   /twilio/*  webhooks from Twilio, authenticated by request signature
//   /auth/*    passkey + failsafe sign-in
//   /api/*     the app's data API, authenticated by bearer session token
//   everything else — the React app, served from this same origin
//
// Serving the app here rather than from GitHub Pages is deliberate. One origin
// means no CORS, no WebAuthn RP-ID mismatch, and no Pages environment branch
// rules — three of the four worst traps recorded in the Mint Voicemail session
// log, removed by a deployment choice rather than by code.

import { verifyTwilioSignature } from './twilio.js';
import { handleInboundMessage, handleMessageStatus } from './messaging.js';
import { handleVoice, handleDial, handleRecording, handleCallStatus } from './voice.js';
import { handleAuth, purgeExpired } from './auth.js';
import { handleApi, purgeTrash } from './api.js';
import { checkPortWatches } from './portwatch.js';
import { json, err, audit } from './util.js';

const HOURLY_CRON = '7 * * * *';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      /* ---- Twilio webhooks ---- */
      if (path.startsWith('/twilio/')) {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

        const params = new URLSearchParams(await req.text());

        // Signature check gates every Twilio route. Without it, anyone who
        // guessed a webhook URL could fabricate messages, forge calls, or burn
        // transcription credit.
        if (!(await verifyTwilioSignature(req, env, params))) {
          await audit(env.DB, 'twilio_signature_rejected', { path }, req);
          return new Response('Forbidden', { status: 403 });
        }

        if (path === '/twilio/message')        return handleInboundMessage(req, env, params, ctx);
        if (path === '/twilio/message-status') return handleMessageStatus(env, params);
        if (path === '/twilio/voice')          return handleVoice(req, env, params);
        if (path === '/twilio/dial')           return handleDial(req, env, params);
        if (path === '/twilio/recording')      return handleRecording(req, env, params, ctx);
        if (path === '/twilio/call-status')    return handleCallStatus(env, params);
        return new Response('Not found', { status: 404 });
      }

      /* ---- auth ---- */
      if (path.startsWith('/auth/')) return await handleAuth(req, env, path, ctx);

      /* ---- app API ---- */
      if (path.startsWith('/api/')) return await handleApi(req, env, path, ctx);

      /* ---- health ---- */
      if (path === '/health') {
        return json({ ok: true, service: 'secondline', time: new Date().toISOString() });
      }

      /* ---- the app ---- */
      // Static assets, with SPA fallback configured in wrangler.toml.
      return env.ASSETS.fetch(req);
    } catch (e) {
      // Log the detail, return something generic — internals stay internal.
      ctx.waitUntil(audit(env.DB, 'unhandled_error', {
        path, error: String(e), stack: e?.stack?.slice(0, 500),
      }));
      return err('Something went wrong', 500);
    }
  },

  // Two schedules share this handler. The hourly one only polls port watches,
  // which is cheap and self-cancelling; the nightly one also expires sessions
  // and challenges and purges aged trash.
  async scheduled(event, env, ctx) {
    const work = [checkPortWatches(env)];
    if (event.cron !== HOURLY_CRON) work.push(purgeExpired(env), purgeTrash(env));
    ctx.waitUntil(Promise.all(work));
  },
};
