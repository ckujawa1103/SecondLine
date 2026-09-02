import { useEffect, useState } from 'react';
import { api, formatPhone, formatWhen, formatDuration } from '../api.js';

export default function Voicemail({ lineId }) {
  const [items, setItems] = useState([]);
  const [trash, setTrash] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);

  const load = () => {
    setLoading(true);
    api.voicemails(trash)
      .then((r) => setItems(r.voicemails || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [trash]);

  // Filtering here rather than in the query keeps the line picker instant —
  // the list is small, and a round trip per toggle would feel worse.
  const shown = lineId ? items.filter((v) => v.number_id === lineId) : items;

  const act = async (fn) => { await fn(); load(); };

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{trash ? 'Trash' : 'Voicemail'}</h1>
        <button className="btn small" onClick={() => { setTrash(!trash); setOpenId(null); }}>
          {trash ? 'Inbox' : 'Trash'}
        </button>
      </div>

      {loading && <p className="muted pad">Loading…</p>}

      {!loading && !shown.length && (
        <div className="empty">
          <div className="empty-title">{trash ? 'Trash is empty' : 'No voicemail'}</div>
          <div className="muted">
            {trash
              ? 'Deleted messages stay here for 30 days.'
              : 'Messages left on your lines will appear here, transcribed.'}
          </div>
        </div>
      )}

      <ul className="list">
        {shown.map((v) => {
          const open = openId === v.id;
          return (
            <li key={v.id} className={v.is_read ? '' : 'unread'}>
              <button
                className="row-btn"
                onClick={() => {
                  setOpenId(open ? null : v.id);
                  if (!v.is_read) api.updateVoicemail(v.id, { is_read: true }).then(load);
                }}
              >
                <div className="row-main">
                  <div className="row-title">
                    {v.contact_name || formatPhone(v.from_number)}
                    {!v.is_read && <span className="dot" />}
                    {v.is_saved === 1 && <span className="tag">Saved</span>}
                  </div>
                  <div className="row-sub">
                    {v.transcript_status === 'pending' && 'Transcribing…'}
                    {v.transcript_status === 'failed' && 'Transcription failed — audio is safe'}
                    {v.transcript_status === 'done' && (v.transcript || 'No speech detected')}
                  </div>
                </div>
                <div className="row-meta">
                  <div>{formatWhen(v.created_at)}</div>
                  <div className="tag">{formatDuration(v.duration_sec)}</div>
                </div>
              </button>

              {open && (
                <div className="detail">
                  {/* Signed, time-limited URL — <audio> cannot send a bearer header. */}
                  <audio controls preload="none" src={v.audioUrl} className="player" />

                  {v.transcript && <p className="transcript">{v.transcript}</p>}

                  {v.transcript_confidence != null && (
                    <p className="muted small">
                      Confidence {Math.round(v.transcript_confidence * 100)}%
                    </p>
                  )}

                  <div className="row wrap">
                    <a className="btn small" href={`tel:${v.from_number}`}>Call back</a>
                    <a className="btn small" href={`sms:${v.from_number}`}>Text back</a>

                    {!trash && (
                      <>
                        <button
                          className="btn small"
                          onClick={() => act(() =>
                            api.updateVoicemail(v.id, { is_saved: !v.is_saved }))}
                        >
                          {v.is_saved ? 'Unsave' : 'Save'}
                        </button>
                        <button
                          className="btn small danger"
                          onClick={() => act(() => api.deleteVoicemail(v.id))}
                        >
                          Delete
                        </button>
                      </>
                    )}

                    {trash && (
                      <button
                        className="btn small"
                        onClick={() => act(() => api.restoreVoicemail(v.id))}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
