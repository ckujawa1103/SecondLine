import { useCallback, useEffect, useState } from 'react';
import { api, formatPhone, getToken, setToken } from './api.js';
import Login from './components/Login.jsx';
import Messages from './components/Messages.jsx';
import Calls from './components/Calls.jsx';
import Voicemail from './components/Voicemail.jsx';
import Settings from './components/Settings.jsx';

const TABS = [
  { id: 'messages', label: 'Messages' },
  { id: 'calls', label: 'Calls' },
  { id: 'voicemail', label: 'Voicemail' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const [signedIn, setSignedIn] = useState(!!getToken());
  const [enrolled, setEnrolled] = useState(null);
  const [tab, setTab] = useState(() => tabFromPath());
  const [numbers, setNumbers] = useState([]);
  // null means "all lines". With more than one number the picker decides which
  // inbox you are looking at; with one it stays out of the way.
  const [lineId, setLineId] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState(null);

  /* Enrollment state drives which door the sign-in screen opens on. */
  useEffect(() => {
    api.status()
      .then((s) => setEnrolled(!!s.enrolled))
      .catch(() => setEnrolled(false));
  }, []);

  /* A magic link lands as /?token=... — consume it and clean the URL. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token || signedIn) return;

    api.magicVerify(token)
      .then((r) => {
        setToken(r.token);
        setSignedIn(true);
        window.history.replaceState({}, '', '/');
      })
      .catch(() => window.history.replaceState({}, '', '/'));
  }, [signedIn]);

  const loadNumbers = useCallback(() => {
    if (!signedIn) return;
    api.numbers().then((r) => setNumbers(r.numbers || [])).catch(() => {});
  }, [signedIn]);

  useEffect(loadNumbers, [loadNumbers]);

  /* Keep the address bar in step so notification deep links and reloads work. */
  useEffect(() => {
    const onPop = () => setTab(tabFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = (next) => {
    setTab(next);
    window.history.pushState({}, '', `/${next === 'messages' ? '' : next}`);
  };

  const onSignedIn = (token, codes) => {
    setToken(token);
    setSignedIn(true);
    if (codes?.length) setRecoveryCodes(codes);
  };

  const signOut = async () => {
    try { await api.logout(); } catch { /* token may already be dead */ }
    setToken(null);
    setSignedIn(false);
  };

  if (!signedIn) {
    if (enrolled === null) return <div className="center muted">Loading…</div>;
    return <Login enrolled={enrolled} onSignedIn={onSignedIn} />;
  }

  if (recoveryCodes) {
    return <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />;
  }

  const line = numbers.find((n) => n.id === lineId) || null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          SecondLine
        </div>

        {numbers.length > 1 && (
          <select
            className="line-picker"
            value={lineId || ''}
            onChange={(e) => setLineId(e.target.value || null)}
          >
            <option value="">All lines</option>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {/* Named by the number people dial, not the catcher behind it. */}
                {n.label || formatPhone(n.serves_number || n.e164)}
              </option>
            ))}
          </select>
        )}
      </header>

      <main className="content">
        {tab === 'messages' && <Messages lineId={lineId} numbers={numbers} />}
        {tab === 'calls' && <Calls lineId={lineId} numbers={numbers} />}
        {tab === 'voicemail' && <Voicemail lineId={lineId} />}
        {tab === 'settings' && (
          <Settings numbers={numbers} onChanged={loadNumbers} onSignOut={signOut} />
        )}
      </main>

      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={t.id === tab ? 'tab active' : 'tab'}
            onClick={() => go(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function tabFromPath() {
  const seg = window.location.pathname.split('/')[1];
  return TABS.some((t) => t.id === seg) ? seg : 'messages';
}

/**
 * Shown exactly once, immediately after enrolling the first passkey.
 *
 * These are the failsafe for a lost phone, and they are never recoverable
 * afterwards — only the PBKDF2 hashes are stored — so the screen refuses to
 * advance until they have been copied or downloaded.
 */
function RecoveryCodes({ codes, onDone }) {
  const [acked, setAcked] = useState(false);

  const download = () => {
    const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'secondline-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setAcked(true);
  };

  return (
    <div className="center">
      <div className="card">
        <h1>Save your recovery codes</h1>
        <p className="muted">
          Ten single-use codes. They are the way back in if you lose your phone,
          and this is the only time they are shown — only their hashes are kept.
        </p>
        <pre className="codes">{codes.join('\n')}</pre>
        <div className="row">
          <button className="btn" onClick={download}>Download</button>
          <button
            className="btn"
            onClick={() => { navigator.clipboard?.writeText(codes.join('\n')); setAcked(true); }}
          >
            Copy
          </button>
        </div>
        <button className="btn primary wide" disabled={!acked} onClick={onDone}>
          {acked ? "I've saved them" : 'Copy or download first'}
        </button>
      </div>
    </div>
  );
}
