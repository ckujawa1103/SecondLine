import { useEffect, useRef, useState } from 'react';
import { api, formatPhone, formatWhen } from '../api.js';

export default function Messages({ lineId, numbers }) {
  const [threads, setThreads] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);

  const load = () => {
    setLoading(true);
    api.threads({ numberId: lineId })
      .then((r) => setThreads(r.threads || []))
      .catch(() => setThreads([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [lineId]);

  if (openId) {
    return (
      <Thread
        id={openId}
        onBack={() => { setOpenId(null); load(); }}
      />
    );
  }

  if (composing) {
    return (
      <Compose
        numbers={numbers}
        defaultNumberId={lineId}
        onCancel={() => setComposing(false)}
        onSent={(threadId) => { setComposing(false); setOpenId(threadId); }}
      />
    );
  }

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>Messages</h1>
        <button className="btn small" onClick={() => setComposing(true)}>New</button>
      </div>

      {loading && <p className="muted pad">Loading…</p>}

      {!loading && !threads.length && (
        <Empty
          title="No conversations yet"
          body={
            numbers.length
              ? 'Texts sent to your numbers will appear here.'
              : 'Add a number first — Settings shows the lines this app knows about.'
          }
        />
      )}

      <ul className="list">
        {threads.map((t) => (
          <li key={t.id}>
            <button className="row-btn" onClick={() => setOpenId(t.id)}>
              <div className="row-main">
                <div className="row-title">
                  {t.contact_name || formatPhone(t.peer_number)}
                  {t.unread_count > 0 && <span className="badge">{t.unread_count}</span>}
                </div>
                <div className="row-sub">{t.last_preview || 'No messages'}</div>
              </div>
              <div className="row-meta">
                <div>{formatWhen(t.last_message_at)}</div>
                {/* Only worth showing which line took it when there are several. */}
                {numbers.length > 1 && (
                  <div className="tag">{t.number_label || formatPhone(t.number_e164)}</div>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Thread({ id, onBack }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const bottom = useRef(null);

  const load = () =>
    api.thread(id).then((r) => setData(r)).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    api.markRead(id).catch(() => {});
  }, [id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'auto' });
  }, [data?.messages?.length]);

  const send = async (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setError(null);
    try {
      await api.send(id, body);
      setDraft('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  if (error && !data) return <div className="pad"><p className="error">{error}</p></div>;
  if (!data) return <p className="muted pad">Loading…</p>;

  const title = data.thread.contact_name || formatPhone(data.thread.peer_number);

  return (
    <div className="pane thread">
      <div className="pane-head">
        <button className="btn small" onClick={onBack}>Back</button>
        <h1>{title}</h1>
      </div>

      <div className="bubbles">
        {data.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.direction}`}>
            {m.body && <div className="bubble-body">{m.body}</div>}

            {(m.media || []).map((med) =>
              med.contentType?.startsWith('image/') ? (
                <img key={med.id} src={med.url} alt="" className="bubble-media" />
              ) : (
                <a key={med.id} href={med.url} className="bubble-file">Attachment</a>
              ),
            )}

            <div className="bubble-meta">
              {formatWhen(m.created_at)}
              {m.status === 'failed' && <span className="error"> · failed</span>}
              {m.error_code === 30034 && (
                <span className="error"> · number not registered for A2P</span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {error && <p className="error pad">{error}</p>}

      <form className="composer" onSubmit={send}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message"
          disabled={sending}
        />
        <button className="btn primary" disabled={sending || !draft.trim()}>
          {sending ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function Compose({ numbers, defaultNumberId, onCancel, onSent }) {
  const [numberId, setNumberId] = useState(defaultNumberId || numbers[0]?.id || '');
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.startThread(numberId, normalize(to), body.trim());
      onSent(r.threadId);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <div className="pane-head">
        <button className="btn small" onClick={onCancel}>Cancel</button>
        <h1>New message</h1>
      </div>

      <form className="form" onSubmit={submit}>
        {numbers.length > 1 && (
          <label>
            From
            <select value={numberId} onChange={(e) => setNumberId(e.target.value)}>
              {numbers.map((n) => (
                <option key={n.id} value={n.id}>{n.label || n.e164}</option>
              ))}
            </select>
          </label>
        )}

        <label>
          To
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="(555) 123-4567"
            inputMode="tel"
          />
        </label>

        <label>
          Message
          <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn primary wide" disabled={busy || !to.trim() || !body.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function Empty({ title, body }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="muted">{body}</div>
    </div>
  );
}

/** Accept whatever someone types and hand E.164 to the API. */
function normalize(input) {
  const digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return input.trim();
}
