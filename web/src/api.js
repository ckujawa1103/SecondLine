// Client for the Worker API.
//
// Same origin as the Worker, so no base URL and no CORS. That is the whole
// reason the app is served from the Worker rather than GitHub Pages: it also
// makes the WebAuthn relying-party ID match automatically, which was a
// recurring source of breakage in the Mint Voicemail build.
//
// The session token lives in localStorage and travels as a bearer header. The
// XSS exposure that implies is mitigated by the strict CSP in index.html and
// by having zero third-party scripts.

const TOKEN_KEY = 'sl_session';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Session died or was revoked elsewhere — drop it so the UI shows sign-in
  // rather than looping on failed requests.
  if (res.status === 401 && auth && token) setToken(null);

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

export const api = {
  /* auth */
  status: () => request('/auth/status', { auth: false }),
  registerOptions: (payload) => request('/auth/register/options', { method: 'POST', body: payload }),
  registerVerify: (payload) => request('/auth/register/verify', { method: 'POST', body: payload }),
  loginOptions: () => request('/auth/login/options', { method: 'POST', body: {}, auth: false }),
  loginVerify: (payload) => request('/auth/login/verify', { method: 'POST', body: payload, auth: false }),
  magicRequest: (email) => request('/auth/magic/request', { method: 'POST', body: { email }, auth: false }),
  magicVerify: (token) => request('/auth/magic/verify', { method: 'POST', body: { token }, auth: false }),
  recoveryUse: (code) => request('/auth/recovery/use', { method: 'POST', body: { code }, auth: false }),
  logout: () => request('/auth/logout', { method: 'POST', body: {} }),
  sessions: () => request('/auth/sessions'),
  revokeSessions: () => request('/auth/sessions', { method: 'DELETE' }),
  credentials: () => request('/auth/credentials'),
  auditLog: () => request('/auth/audit'),

  /* lines */
  numbers: () => request('/api/numbers'),
  updateNumber: (id, patch) => request(`/api/numbers/${id}`, { method: 'PATCH', body: patch }),

  /* messages */
  threads: ({ numberId, archived } = {}) => {
    const p = new URLSearchParams();
    if (numberId) p.set('number', numberId);
    if (archived) p.set('archived', '1');
    return request(`/api/threads?${p}`);
  },
  thread: (id, before) =>
    request(`/api/threads/${id}${before ? `?before=${before}` : ''}`),
  send: (threadId, body, mediaUrls) =>
    request(`/api/threads/${threadId}/send`, { method: 'POST', body: { body, mediaUrls } }),
  startThread: (numberId, to, body) =>
    request('/api/send', { method: 'POST', body: { numberId, to, body } }),
  markRead: (threadId) => request(`/api/threads/${threadId}/read`, { method: 'POST', body: {} }),
  updateThread: (id, patch) => request(`/api/threads/${id}`, { method: 'PATCH', body: patch }),

  /* calls */
  calls: () => request('/api/calls'),
  bridgeCall: (numberId, to, bridgeTo) =>
    request('/api/calls/bridge', { method: 'POST', body: { numberId, to, bridgeTo } }),
  voiceToken: () => request('/api/voice/token', { method: 'POST', body: {} }),

  /* voicemail */
  voicemails: (trash = false) => request(`/api/voicemails${trash ? '?trash=1' : ''}`),
  updateVoicemail: (id, patch) => request(`/api/voicemails/${id}`, { method: 'PATCH', body: patch }),
  deleteVoicemail: (id) => request(`/api/voicemails/${id}`, { method: 'DELETE' }),
  restoreVoicemail: (id) => request(`/api/voicemails/${id}/restore`, { method: 'POST', body: {} }),

  /* contacts */
  contacts: () => request('/api/contacts'),
  addContact: (payload) => request('/api/contacts', { method: 'POST', body: payload }),

  /* push */
  pushKey: () => request('/api/push/key'),
  pushSubscribe: (sub) => request('/api/push/subscribe', { method: 'POST', body: sub }),
  pushUnsubscribe: (endpoint) =>
    request('/api/push/unsubscribe', { method: 'POST', body: { endpoint } }),
};

/* ---------- formatting ---------- */

export function formatPhone(e164) {
  if (!e164) return 'Unknown';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function formatWhen(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();

  if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const days = Math.floor((now - d) / 86400000);
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatDuration(seconds) {
  const s = parseInt(seconds, 10) || 0;
  if (s < 60) return `0:${String(s).padStart(2, '0')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
