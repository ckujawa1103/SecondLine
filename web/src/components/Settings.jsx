import { useEffect, useState } from 'react';
import { api, formatPhone } from '../api.js';
import { subscribePush, unsubscribePush, pushState } from '../push.js';

export default function Settings({ numbers, onChanged, onSignOut }) {
  const [editing, setEditing] = useState(null);
  const [push, setPush] = useState(pushState());
  const [sessions, setSessions] = useState([]);
  const [audit, setAudit] = useState([]);

  useEffect(() => {
    api.sessions().then((r) => setSessions(r.sessions || [])).catch(() => {});
    api.auditLog().then((r) => setAudit((r.events || []).slice(0, 15))).catch(() => {});
  }, []);

  const togglePush = async () => {
    try {
      if (push === 'granted') { await unsubscribePush(); setPush('off'); }
      else { await subscribePush(); setPush('granted'); }
    } catch (e) {
      alert(e.message);
    }
  };

  if (editing) {
    return (
      <EditLine
        line={editing}
        onDone={() => { setEditing(null); onChanged(); }}
      />
    );
  }

  return (
    <div className="pane">
      <div className="pane-head"><h1>Settings</h1></div>

      <section className="section">
        <h2>Lines</h2>
        {!numbers.length && (
          <p className="muted">
            No numbers yet. Provision one with <code>npm run number:buy</code>.
          </p>
        )}
        <ul className="list">
          {numbers.map((n) => (
            <li key={n.id}>
              <button className="row-btn" onClick={() => setEditing(n)}>
                <div className="row-main">
                  <div className="row-title">{n.label || formatPhone(n.e164)}</div>
                  <div className="row-sub">
                    {formatPhone(n.e164)}
                    {n.forward_to ? ` · rings ${formatPhone(n.forward_to)}` : ' · straight to voicemail'}
                  </div>
                  <div className="row-sub muted small">
                    {n.notify_email || 'default email'}
                    {!n.messaging_service_sid && ' · texting not registered'}
                  </div>
                </div>
                <div className="row-meta">Edit</div>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2>Notifications</h2>
        <button className="btn" onClick={togglePush}>
          {push === 'granted' ? 'Disable push on this device' : 'Enable push on this device'}
        </button>
        <p className="hint">
          Transcripts also go out by email, routed per line.
        </p>
      </section>

      <section className="section">
        <h2>Security</h2>
        <p className="muted small">{sessions.length} active session{sessions.length === 1 ? '' : 's'}</p>
        <div className="row wrap">
          <button
            className="btn small"
            onClick={() => api.revokeSessions().then(onSignOut)}
          >
            Sign out everywhere
          </button>
          <button className="btn small" onClick={onSignOut}>Sign out</button>
        </div>

        {audit.length > 0 && (
          <>
            <h3 className="sub">Recent activity</h3>
            <ul className="audit">
              {audit.map((e) => (
                <li key={e.id}>
                  <span className="mono">{e.event}</span>
                  <span className="muted"> · {new Date(e.created_at * 1000).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function EditLine({ line, onDone }) {
  const [form, setForm] = useState({
    label: line.label || '',
    forward_to: line.forward_to || '',
    forward_timeout_sec: line.forward_timeout_sec ?? 20,
    greeting_text: line.greeting_text || '',
    notify_email: line.notify_email || '',
    email_texts: line.email_texts ?? 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value;
    setForm({ ...form, [k]: v });
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateNumber(line.id, {
        ...form,
        forward_to: form.forward_to.trim() || null,
        notify_email: form.notify_email.trim() || null,
        forward_timeout_sec: parseInt(form.forward_timeout_sec, 10) || 20,
      });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <div className="pane-head">
        <button className="btn small" onClick={onDone}>Back</button>
        <h1>{formatPhone(line.e164)}</h1>
      </div>

      <form className="form" onSubmit={save}>
        <label>
          Label
          <input value={form.label} onChange={set('label')} placeholder="Quest" />
          <span className="hint">Prefixes email subjects, so a shared inbox stays readable.</span>
        </label>

        <label>
          Ring this number first
          <input
            value={form.forward_to}
            onChange={set('forward_to')}
            placeholder="Leave empty for voicemail only"
            inputMode="tel"
          />
        </label>

        <label>
          Ring for
          <input
            type="number"
            min="5"
            max="60"
            value={form.forward_timeout_sec}
            onChange={set('forward_timeout_sec')}
          />
          <span className="hint">Seconds before falling through to voicemail.</span>
        </label>

        <label>
          Greeting
          <textarea
            rows={3}
            value={form.greeting_text}
            onChange={set('greeting_text')}
            placeholder="Hi, you've reached… Please leave a message after the tone."
          />
          <span className="hint">
            Spoken by text-to-speech. To use a recording instead, call the number
            and record it — phone audio is already the right format.
          </span>
        </label>

        <label>
          Send transcripts to
          <input
            type="email"
            value={form.notify_email}
            onChange={set('notify_email')}
            placeholder="Defaults to the account owner"
          />
        </label>

        <label className="check">
          <input type="checkbox" checked={!!form.email_texts} onChange={set('email_texts')} />
          Email every inbound text on this line
          <span className="hint">
            Useful for a line you rarely open. Noisy on anything busy.
          </span>
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </div>
  );
}
