import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import BotSelector from '../components/BotSelector';
import RangeSwitcher from '../components/RangeSwitcher';
import TopicChart from '../components/TopicChart';

function UnansweredQuestions({ botId, range }) {
  const { apiJson } = useApi();
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ range });
    if (botId) params.set('bot_id', botId);
    return apiJson(`/api/analytics/unanswered?${params}`)
      .then((data) => setQuestions(data.questions || []))
      .catch(() => setQuestions([]));
  }, [apiJson, botId, range]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function resolve(question) {
    setResolving(question.ids[0]);
    try {
      await apiJson(`/api/analytics/unanswered/${question.ids[0]}/resolve`, { method: 'POST' });
      await load();
    } catch {
      // the row stays listed; nothing else to do
    } finally {
      setResolving(null);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm mt-6">
      <div className="px-5 py-4 border-b border-slate-200">
        <h3 className="font-semibold text-slate-800">Unanswered questions</h3>
        <p className="text-xs text-slate-500 mt-0.5">Questions your catalog could not answer</p>
      </div>
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="w-6 h-6 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : questions.length === 0 ? (
        <p className="text-sm text-slate-500 text-center py-10">No unanswered questions in this period.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {questions.map((q) => (
            <li key={q.ids[0]} className="flex items-center gap-4 px-5 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800 break-words">{q.question}</p>
                <p className="text-xs text-slate-500 mt-0.5">Last asked {new Date(q.last_asked).toLocaleString()}</p>
              </div>
              <span className="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                {q.count}×
              </span>
              <button
                type="button"
                disabled={resolving === q.ids[0]}
                onClick={() => resolve(q)}
                className="shrink-0 text-sm text-indigo-600 hover:text-indigo-800 font-medium disabled:opacity-40"
              >
                Mark resolved
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Topics() {
  const { apiJson } = useApi();
  const [range, setRange] = useState('30');
  const [botId, setBotId] = useState(null);
  const [data, setData] = useState({ top_detected: [], top_blocked: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ range });
    if (botId) params.set('bot_id', botId);

    apiJson(`/api/analytics/topics?${params}`)
      .then(setData)
      .catch(() => setData({ top_detected: [], top_blocked: [] }))
      .finally(() => setLoading(false));
  }, [apiJson, range, botId]);

  return (
    <div className="p-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Topics</h1>
          <p className="text-sm text-slate-500 mt-1">What visitors are asking about</p>
        </div>
        <div className="flex items-center gap-3">
          <BotSelector selectedBotId={botId} onBotChange={setBotId} />
          <RangeSwitcher value={range} onChange={setRange} />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TopicChart
            title="Top Topics Asked"
            data={data.top_detected}
            color="#6366f1"
            emptyMessage="No topics detected yet — paste your embed code to get started."
          />
          <TopicChart
            title="Blocked Topic Attempts"
            data={data.top_blocked}
            color="#ef4444"
            emptyMessage="No blocked topic attempts in this period."
          />
        </div>
      )}

      <UnansweredQuestions botId={botId} range={range} />
    </div>
  );
}
