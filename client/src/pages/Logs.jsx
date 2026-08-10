import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import BotSelector from '../components/BotSelector';
import RangeSwitcher from '../components/RangeSwitcher';
import SessionDrawer from '../components/SessionDrawer';
import EmptyState from '../components/EmptyState';

const OUTCOMES = ['', 'resolved', 'escalated', 'abandoned', 'blocked'];

const OUTCOME_STYLES = {
  resolved: 'bg-emerald-100 text-emerald-700',
  escalated: 'bg-amber-100 text-amber-700',
  abandoned: 'bg-slate-100 text-slate-600',
  blocked: 'bg-red-100 text-red-700',
};

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export default function Logs() {
  const { apiJson } = useApi();
  const [range, setRange] = useState('30');
  const [botId, setBotId] = useState(null);
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ sessions: [], pagination: {} });
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState(null);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ range, page: String(page), limit: '20' });
    if (botId) params.set('bot_id', botId);
    if (search.trim()) params.set('search', search.trim());
    if (outcome) params.set('outcome', outcome);
    if (blockedOnly) params.set('blocked', 'true');

    const timer = setTimeout(() => {
      apiJson(`/api/analytics/sessions?${params}`)
        .then(setData)
        .catch(() => setData({ sessions: [], pagination: {} }))
        .finally(() => setLoading(false));
    }, search ? 300 : 0);

    return () => clearTimeout(timer);
  }, [apiJson, range, botId, search, outcome, blockedOnly, page]);

  const { sessions, pagination } = data;

  return (
    <div className="p-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Chat Logs</h1>
          <p className="text-sm text-slate-500 mt-1">Browse and inspect conversation sessions</p>
        </div>
        <div className="flex items-center gap-3">
          <BotSelector selectedBotId={botId} onBotChange={(id) => { setBotId(id); setPage(1); }} />
          <RangeSwitcher value={range} onChange={(r) => { setRange(r); setPage(1); }} />
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="search"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search messages…"
          className="flex-1 min-w-[200px] px-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
        />
        <select
          value={outcome}
          onChange={(e) => { setOutcome(e.target.value); setPage(1); }}
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
        >
          {OUTCOMES.map((o) => (
            <option key={o || 'all'} value={o}>{o ? o.charAt(0).toUpperCase() + o.slice(1) : 'All outcomes'}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white cursor-pointer">
          <input
            type="checkbox"
            checked={blockedOnly}
            onChange={(e) => { setBlockedOnly(e.target.checked); setPage(1); }}
            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          Blocked only
        </label>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No sessions found"
            message="No sessions yet — paste your embed code to get started."
            icon="table"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Session ID</th>
                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Started At</th>
                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Turns</th>
                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Outcome</th>
                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Blocked</th>
                    <th className="text-left px-4 py-3 font-semibold text-slate-600">Topics</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr
                      key={s.session_id}
                      onClick={() => setSelectedSession(s.session_id)}
                      className="border-b border-slate-100 hover:bg-indigo-50/50 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {s.session_id?.slice(0, 8)}…
                      </td>
                      <td className="px-4 py-3 text-slate-700">{formatDate(s.started_at)}</td>
                      <td className="px-4 py-3 text-slate-700">{s.turn_count}</td>
                      <td className="px-4 py-3">
                        {s.outcome && (
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${OUTCOME_STYLES[s.outcome] || 'bg-slate-100 text-slate-600'}`}>
                            {s.outcome}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">{s.blocked ? '🚫' : ''}</td>
                      <td className="px-4 py-3 text-slate-500 text-xs max-w-[200px] truncate">
                        {(s.topics_detected || []).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 bg-slate-50">
              <p className="text-xs text-slate-500">
                Page {pagination.page} of {pagination.total_pages || 1} · {pagination.total} sessions
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white disabled:opacity-40 hover:bg-slate-50"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={page >= (pagination.total_pages || 1)}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white disabled:opacity-40 hover:bg-slate-50"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <SessionDrawer
        sessionId={selectedSession}
        onClose={() => setSelectedSession(null)}
      />
    </div>
  );
}
