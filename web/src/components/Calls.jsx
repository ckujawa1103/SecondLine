import { useEffect, useState } from 'react';
import { api, formatPhone, formatWhen, formatDuration } from '../api.js';

const LABELS = {
  answered: 'Answered',
  missed: 'Missed',
  voicemail: 'Voicemail',
  busy: 'Busy',
  failed: 'Failed',
  'in-progress': 'In progress',
};

export default function Calls({ lineId, numbers }) {
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialing, setDialing] = useState(false);

  const load = () => {
    setLoading(true);
    api.calls({ numberId: lineId })
      .then((r) => setCalls(r.calls || []))
      .catch(() => setCalls([]))
      .finally(() => setLoading(false));
  };

  // Filtered in the query for the same reason as voicemail: LIMIT runs first.
  useEffect(load, [lineId]);

  const shown = calls;

  if (dialing) {
    return (
      <Dialer
        numbers={numbers}
        defaultNumberId={lineId}
        onDone={() => { setDialing(false); load(); }}
      />
    );
  }

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>Calls</h1>
        <button className="btn small" onClick={() => setDialing(true)}>Dial</button>
      </div>

      {loading && <p className="muted pad">Loading…</p>}

      {!loading && !shown.length && (
        <div className="empty">
          <div className="empty-title">No calls yet</div>
          <div className="muted">Incoming and outgoing calls will be logged here.</div>
        </div>
      )}

      <ul className="list">
        {shown.map((c) => (
          <li key={c.id} className={c.disposition === 'missed' && !c.read_at ? 'unread' : ''}>
            <div className="row-btn static">
              <div className="row-main">
                <div className="row-title">
                  {c.contact_name || c.peer_name || formatPhone(c.peer_number)}
                </div>
                <div className="row-sub">
                  {c.direction === 'inbound' ? '↓' : '↑'} {LABELS[c.disposition] || c.disposition}
                  {c.duration_sec > 0 && ` · ${formatDuration(c.duration_sec)}`}
                  {c.peer_city && ` · ${c.peer_city}, ${c.peer_state}`}
                </div>
              </div>
              <div className="row-meta">
                <div>{formatWhen(c.created_at)}</div>
                {c.voicemail_id && <div className="tag">VM</div>}
                {/* Which line took the call, named the way callers know it. */}
                {(c.number_label || c.serves_number) && (
                  <div className="tag line">
                    {c.number_label || formatPhone(c.serves_number)}
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Outbound calling, by the bridge route.
 *
 * Twilio rings your phone first, then dials the recipient with the project
 * number as caller ID. The in-app WebRTC dialer needs the Twilio Voice SDK
 * loaded and a TwiML App configured; until that is set up, the bridge works
 * from any phone with no microphone permission at all.
 */
function Dialer({ numbers, defaultNumberId, onDone }) {
  const [numberId, setNumberId] = useState(defaultNumberId || numbers[0]?.id || '');
  const [to, setTo] = useState('');
  const [bridgeTo, setBridgeTo] = useState(() => localStorage.getItem('sl_bridge_to') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [placed, setPlaced] = useState(false);

  const call = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem('sl_bridge_to', bridgeTo);
      await api.bridgeCall(numberId, normalize(to), normalize(bridgeTo));
      setPlaced(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (placed) {
    return (
      <div className="pane">
        <div className="empty">
          <div className="empty-title">Calling you now</div>
          <div className="muted">
            Answer, and we'll connect you to {formatPhone(normalize(to))}.
          </div>
          <button className="btn primary" onClick={onDone}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane-head">
        <button className="btn small" onClick={onDone}>Cancel</button>
        <h1>Place a call</h1>
      </div>

      <form className="form" onSubmit={call}>
        {numbers.length > 1 && (
          <label>
            Show as
            <select value={numberId} onChange={(e) => setNumberId(e.target.value)}>
              {numbers.map((n) => (
                <option key={n.id} value={n.id}>{n.label || n.e164}</option>
              ))}
            </select>
          </label>
        )}

        <label>
          Call
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="(555) 123-4567"
            inputMode="tel"
          />
        </label>

        <label>
          Ring me at
          <input
            value={bridgeTo}
            onChange={(e) => setBridgeTo(e.target.value)}
            placeholder="Your phone"
            inputMode="tel"
          />
          <span className="hint">
            We call this first, then connect you. Costs two legs, needs no microphone.
          </span>
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn primary wide" disabled={busy || !to.trim() || !bridgeTo.trim()}>
          {busy ? 'Placing…' : 'Call'}
        </button>
      </form>
    </div>
  );
}

function normalize(input) {
  const digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return String(input).trim();
}
