// Twilio plumbing shared by the voice and messaging webhooks: signature
// verification, TwiML helpers, and authenticated REST calls.

/**
 * Validate X-Twilio-Signature.
 *
 * Twilio signs the full request URL with the POST parameters appended in
 * lexicographic key order, HMAC-SHA1 under the account auth token. This gates
 * every webhook route. Without it, anyone who learned a webhook URL could
 * fabricate inbound messages, forge calls, or burn transcription credit.
 */
export async function verifyTwilioSignature(req, env, bodyParams) {
  const signature = req.headers.get('X-Twilio-Signature');
  if (!signature || !env.TWILIO_AUTH_TOKEN) return false;

  // Twilio signs the URL as configured. Behind Cloudflare the inbound URL is
  // already https, but normalize defensively — a scheme mismatch here fails
  // every request with no useful error.
  const url = new URL(req.url);
  url.protocol = 'https:';
  url.port = '';

  let payload = url.toString();
  for (const key of [...bodyParams.keys()].sort()) {
    payload += key + bodyParams.get(key);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TWILIO_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Both sides are base64 of a fixed-length digest, so length is constant.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/* ---------- TwiML ---------- */

export function twiml(xml) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${xml}`, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

export function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

/* ---------- REST ---------- */

// Prefer an API key: it can be revoked on its own, whereas rotating the auth
// token would simultaneously break signature verification above.
function restAuth(env) {
  const user = env.TWILIO_API_KEY || env.TWILIO_ACCOUNT_SID;
  const pass = env.TWILIO_API_KEY ? env.TWILIO_API_SECRET : env.TWILIO_AUTH_TOKEN;
  return 'Basic ' + btoa(`${user}:${pass}`);
}

export async function twilioRest(env, method, path, form) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: restAuth(env),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }

  if (!res.ok) {
    const e = new Error(data?.message || `Twilio ${res.status}`);
    e.status = res.status;
    e.code = data?.code;
    throw e;
  }
  return data;
}

/**
 * Fetch a Twilio-hosted asset (recording audio, MMS media) with account
 * credentials. Twilio can publish the callback marginally before the asset is
 * retrievable, so retry 404s with backoff.
 */
export async function fetchTwilioAsset(env, url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Authorization: restAuth(env) } });
    if (res.ok) {
      return {
        body: await res.arrayBuffer(),
        contentType: res.headers.get('Content-Type') || 'application/octet-stream',
      };
    }
    if (res.status !== 404) break;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  return null;
}

/**
 * Delete Twilio's copy of an asset once ours is safely in R2.
 *
 * Two reasons, both from the Mint Voicemail build: it costs storage every
 * month, and it means your messages live in exactly one place you control.
 * Non-fatal — worst case the copy lingers.
 */
export async function deleteTwilioAsset(env, path) {
  try {
    await twilioRest(env, 'DELETE', path);
  } catch {
    // Ignore: we already have the bytes.
  }
}
