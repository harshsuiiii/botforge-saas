import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import BotSelector from '../components/BotSelector';
import RangeSwitcher from '../components/RangeSwitcher';
import TopicChart from '../components/TopicChart';

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
    </div>
  );
}
