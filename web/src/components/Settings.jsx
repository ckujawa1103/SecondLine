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
                    {n.serves_number
                      ? `voicemail for ${formatPhone(n.serves_number)}`
                      : formatPhone(n.e164)}
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
    serves_number: line.serves_number || '',
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
        serves_number: form.serves_number.trim() || null,
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
          Voicemail for
          <input
            value={form.serves_number}
            onChange={set('serves_number')}
            placeholder="The number callers actually dial"
            inputMode="tel"
          />
          <span className="hint">
            Set this when the line is a catcher reached by conditional forwarding.
            The app and the emails name this number instead of the Twilio one.
          </span>
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

      <CallerGreetings lineId={line.id} />
    </div>
  );
}

/**
 * Per-caller greetings for one line.
 *
 * The line's own greeting answers everyone; a rule here answers one number
 * differently. Caller ID is all it matches on, which is plenty for a family
 * bit and not something to lean on for anything that matters.
 */
function CallerGreetings({ lineId }) {
  const [rules, setRules] = useState([]);
  const [adding, setAdding] = useState(false);

  const load = () =>
    api.greetingRules()
      .then((r) => setRules((r.rules || []).filter((x) => x.number_id === lineId)))
      .catch(() => setRules([]));

  useEffect(() => { load(); }, [lineId]);

  const remove = async (id) => {
    if (!confirm('Delete this greeting? The recording goes with it.')) return;
    await api.deleteGreetingRule(id);
    load();
  };

  const toggle = async (rule) => {
    await api.updateGreetingRule(rule.id, { is_active: rule.is_active ? 0 : 1 });
    load();
  };

  return (
    <section className="section">
      <h2>Greetings for specific callers</h2>

      {!rules.length && !adding && (
        <p className="hint">
          Everyone hears this line's greeting. Add a rule to answer one number
          with something else.
        </p>
      )}

      <ul className="list">
        {rules.map((r) => (
          <li key={r.id}>
            <div className="row-btn static">
              <div className="row-main">
                <div className="row-title">
                  {r.label || 'Custom greeting'}
                  {!r.is_active && <span className="tag">Off</span>}
                  {r.greeting_mode === 'audio' && <span className="tag">Recorded</span>}
                </div>
                <div className="row-sub">
                  when {formatPhone(r.caller_number)} calls
                  {season(r) && ` · ${season(r)}`}
                </div>
                {r.greeting_mode === 'tts' && r.greeting_text && (
                  <div className="row-sub small muted">“{r.greeting_text}”</div>
                )}
                {r.greeting_mode === 'tts' && !r.greeting_text && (
                  <div className="row-sub small muted">
                    No greeting set yet — record one and assign it from Voicemail.
                  </div>
                )}
              </div>
              <div className="row-meta">
                <button className="link" onClick={() => toggle(r)}>
                  {r.is_active ? 'Turn off' : 'Turn on'}
                </button>
                <button className="link danger" onClick={() => remove(r.id)}>Delete</button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <AddRule
          lineId={lineId}
          onDone={() => { setAdding(false); load(); }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button className="btn small" onClick={() => setAdding(true)}>Add a caller</button>
      )}
    </section>
  );
}

/** "Dec 1 – Dec 26", or nothing when the rule runs year-round. */
function season(r) {
  const d = (t) =>
    new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (r.starts_at && r.ends_at) return `${d(r.starts_at)} – ${d(r.ends_at)}`;
  if (r.starts_at) return `from ${d(r.starts_at)}`;
  if (r.ends_at) return `until ${d(r.ends_at)}`;
  return null;
}

function AddRule({ lineId, onDone, onCancel }) {
  const [form, setForm] = useState({
    caller_number: '', label: '', greeting_text: '', starts_at: '', ends_at: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  // A date input gives a local calendar day; the end of the season means the
  // end of that day, not midnight at its start, or the last day would be dead.
  const epoch = (value, endOfDay) => {
    if (!value) return null;
    const [y, m, d] = value.split('-').map(Number);
    const date = endOfDay
      ? new Date(y, m - 1, d, 23, 59, 59)
      : new Date(y, m - 1, d, 0, 0, 0);
    return Math.floor(date.getTime() / 1000);
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createGreetingRule({
        number_id: lineId,
        caller_number: form.caller_number,
        label: form.label.trim() || null,
        greeting_text: form.greeting_text.trim() || null,
        starts_at: epoch(form.starts_at, false),
        ends_at: epoch(form.ends_at, true),
      });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="form inset" onSubmit={save}>
      <label>
        When this number calls
        <input
          value={form.caller_number}
          onChange={set('caller_number')}
          placeholder="(555) 123-4567"
          inputMode="tel"
          required
        />
      </label>

      <label>
        Name it
        <input value={form.label} onChange={set('label')} placeholder="Santa's Hotline" />
      </label>

      <label>
        Say this
        <textarea
          rows={3}
          value={form.greeting_text}
          onChange={set('greeting_text')}
          placeholder="Ho ho ho! You've reached the North Pole…"
        />
        <span className="hint">
          Text-to-speech, and a fine placeholder. For a real voice, call the
          line and leave the greeting as a message, then open it in Voicemail
          and tap “Use as greeting”.
        </span>
      </label>

      <div className="row wrap">
        <label style={{ flex: 1 }}>
          Starts
          <input type="date" value={form.starts_at} onChange={set('starts_at')} />
        </label>
        <label style={{ flex: 1 }}>
          Ends
          <input type="date" value={form.ends_at} onChange={set('ends_at')} />
        </label>
      </div>
      <span className="hint">
        Optional. Outside these dates the caller hears the line's normal
        greeting — which beats remembering to switch Santa off in January.
      </span>

      {error && <p className="error">{error}</p>}

      <div className="row wrap">
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add greeting'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
