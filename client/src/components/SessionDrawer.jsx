import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

export default function SessionDrawer({ sessionId, onClose }) {
  const { apiJson } = useApi();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!sessionId) return;

    setLoading(true);
    setError(null);
    apiJson(`/api/analytics/sessions/${sessionId}`)
      .then((data) => setSession(data.session))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId, apiJson]);

  if (!sessionId) return null;

  const messages = session?.messages ?? [];

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} aria-hidden="true" />
      <aside className="fixed top-0 right-0 h-full w-[400px] max-w-full bg-white shadow-2xl z-50 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="font-semibold text-slate-900">Session transcript</h2>
            {session && (
              <p className="text-xs text-slate-500 mt-0.5 font-mono">
                {session.session_id?.slice(0, 8)}…
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && <p className="text-sm text-slate-500 text-center py-8">Loading transcript…</p>}
          {error && <p className="text-sm text-red-600 text-center py-8">{error}</p>}
          {!loading && !error && messages.map((msg, i) => {
            const isUser = msg.role === 'user';
            return (
              <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                    isUser
                      ? 'bg-indigo-600 text-white rounded-br-md'
                      : 'bg-slate-100 text-slate-800 rounded-bl-md'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  {msg.ts && (
                    <p className={`text-[10px] mt-1 ${isUser ? 'text-indigo-200' : 'text-slate-400'}`}>
                      {formatTime(msg.ts)}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {session && (
          <div className="px-5 py-3 border-t border-slate-200 text-xs text-slate-500 space-y-1">
            <p>Bot: {session.bot_name}</p>
            <p>Outcome: {session.outcome ?? '—'} · Turns: {session.turn_count}</p>
            {session.topics_detected?.length > 0 && (
              <p>Topics: {session.topics_detected.join(', ')}</p>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
