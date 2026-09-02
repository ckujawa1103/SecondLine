import { useState } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { api } from '../api.js';

/**
 * Three doors, one lock:
 *   passkey — the everyday path, nothing to remember
 *   email   — magic link to the owner address        [failsafe]
 *   code    — one of ten single-use recovery codes   [failsafe]
 *
 * Both failsafes grant a session AND the right to enroll a fresh passkey.
 * That distinction is the difference between losing your phone being an
 * inconvenience and being a lockout.
 */
export default function Login({ enrolled, onSignedIn }) {
  const [mode, setMode] = useState(enrolled ? 'passkey' : 'setup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [setupCode, setSetupCode] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  const run = async (fn) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const signInWithPasskey = () => run(async () => {
    const { options, challengeId } = await api.loginOptions();
    const response = await startAuthentication({ optionsJSON: options });
    const result = await api.loginVerify({ challengeId, response });
    onSignedIn(result.token);
  });

  const firstTimeSetup = () => run(async () => {
    const { options, challengeId } = await api.registerOptions({ setupCode: setupCode.trim() });
    const response = await startRegistration({ optionsJSON: options });
    const result = await api.registerVerify({ challengeId, response, label: deviceLabel() });
    onSignedIn(result.token, result.recoveryCodes);
  });

  const sendMagicLink = () => run(async () => {
    const res = await api.magicRequest(email.trim());
    // Deliberately the same response whether or not the address matches, so
    // this cannot be used to discover the owner's email.
    setNotice(res.message || 'If that address is on file, a sign-in link is on its way.');
  });

  const useRecoveryCode = () => run(async () => {
    const result = await api.recoveryUse(code.trim());
    onSignedIn(result.token);
  });

  return (
    <div className="center">
      <div className="card auth-card">
        <div className="brand big">
          <span className="brand-dot" />
          SecondLine
        </div>

        {mode === 'setup' && (
          <>
            <h1>First-time setup</h1>
            <p className="muted">
              Enter the setup code configured on the Worker, then create a passkey.
              Recovery codes come right after.
            </p>
            <input
              type="password"
              placeholder="Setup code"
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
            />
            <button className="btn primary wide" disabled={busy} onClick={firstTimeSetup}>
              {busy ? 'Working…' : 'Create passkey'}
            </button>
          </>
        )}

        {mode === 'passkey' && (
          <>
            <h1>Sign in</h1>
            <p className="muted">Use Face ID, Touch ID, Windows Hello, or a security key.</p>
            <button className="btn primary wide" disabled={busy} onClick={signInWithPasskey}>
              {busy ? 'Waiting…' : 'Sign in with passkey'}
            </button>
          </>
        )}

        {mode === 'email' && (
          <>
            <h1>Email a sign-in link</h1>
            <p className="muted">Only ever sent to the owner address on file.</p>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="btn primary wide" disabled={busy} onClick={sendMagicLink}>
              {busy ? 'Sending…' : 'Send link'}
            </button>
          </>
        )}

        {mode === 'code' && (
          <>
            <h1>Recovery code</h1>
            <p className="muted">One of the ten codes saved at setup. Each works once.</p>
            <input
              placeholder="XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoCapitalize="characters"
            />
            <button className="btn primary wide" disabled={busy} onClick={useRecoveryCode}>
              {busy ? 'Checking…' : 'Use code'}
            </button>
          </>
        )}

        {error && <p className="error">{error}</p>}
        {notice && <p className="notice">{notice}</p>}

        {enrolled && (
          <div className="alt-links">
            {mode !== 'passkey' && <button className="link" onClick={() => setMode('passkey')}>Passkey</button>}
            {mode !== 'email' && <button className="link" onClick={() => setMode('email')}>Email a link</button>}
            {mode !== 'code' && <button className="link" onClick={() => setMode('code')}>Recovery code</button>}
          </div>
        )}
      </div>
    </div>
  );
}

/** A human-readable name for this device, so Settings lists something useful. */
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'This device';
}
