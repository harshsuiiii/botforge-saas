import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Bar, Doughnut } from 'react-chartjs-2';
import { useApi } from '../hooks/useApi';
import BotSelector from '../components/BotSelector';
import RangeSwitcher from '../components/RangeSwitcher';
import StatCard from '../components/StatCard';
import EmptyState from '../components/EmptyState';

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, ArcElement, Title, Tooltip, Legend, Filler,
);

function computeTrend(dailyData) {
  if (!dailyData?.length || dailyData.length < 2) return null;
  const mid = Math.floor(dailyData.length / 2);
  const first = dailyData.slice(0, mid).reduce((s, d) => s + d.count, 0);
  const second = dailyData.slice(mid).reduce((s, d) => s + d.count, 0);
  if (first === 0) return second > 0 ? 100 : 0;
  return ((second - first) / first) * 100;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function Dashboard() {
  const { id: routeBotId } = useParams();
  const { apiJson } = useApi();
  const [range, setRange] = useState('30');
  const [botId, setBotId] = useState(routeBotId || null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setBotId(routeBotId || null);
  }, [routeBotId]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ range });
    if (botId) params.set('bot_id', botId);

    apiJson(`/api/analytics/overview?${params}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [apiJson, range, botId]);

  const messageTrend = useMemo(() => computeTrend(data?.daily_message_volume), [data]);
  const hasData = data && (data.total_messages > 0 || data.unique_users > 0);

  const lineData = {
    labels: (data?.daily_message_volume ?? []).map((d) => formatDate(d.date)),
    datasets: [{
      label: 'Messages',
      data: (data?.daily_message_volume ?? []).map((d) => d.count),
      borderColor: '#6366f1',
      backgroundColor: 'rgba(99, 102, 241, 0.1)',
      fill: true,
      tension: 0.3,
    }],
  };

  const barData = {
    labels: (data?.sessions_by_hour ?? []).map((h) => `${h.hour}:00`),
    datasets: [{
      label: 'Sessions',
      data: (data?.sessions_by_hour ?? []).map((h) => h.count),
      backgroundColor: '#818cf8',
      borderRadius: 4,
    }],
  };

  const resolution = data?.resolution_rate ?? { resolved: '0.0', escalated: '0.0', abandoned: '0.0' };
  const donutData = {
    labels: [
      `Resolved (${resolution.resolved}%)`,
      `Escalated (${resolution.escalated}%)`,
      `Abandoned (${resolution.abandoned}%)`,
    ],
    datasets: [{
      data: [
        parseFloat(resolution.resolved),
        parseFloat(resolution.escalated),
        parseFloat(resolution.abandoned),
      ],
      backgroundColor: ['#10b981', '#f59e0b', '#94a3b8'],
      borderWidth: 0,
    }],
  };

  return (
    <div className="p-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Overview</h1>
          <p className="text-sm text-slate-500 mt-1">Analytics for your chat widgets</p>
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
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard
              label="Total Messages"
              value={data?.total_messages ?? 0}
              trend={messageTrend}
              trendLabel="vs previous half of period"
            />
            <StatCard
              label="Unique Users"
              value={data?.unique_users ?? 0}
              trend={messageTrend}
              trendLabel="estimated from message trend"
            />
            <StatCard
              label="Avg Turns / Session"
              value={data?.avg_turns_per_session ?? 0}
            />
            <StatCard
              label="Blocked Attempts"
              value={data?.blocked_count ?? 0}
            />
          </div>

          {!hasData ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
              <EmptyState
                title="No sessions yet"
                message="No sessions yet — paste your embed code to get started."
                icon="chart"
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                  <h3 className="font-semibold text-slate-800 mb-4">Daily Message Volume</h3>
                  <div className="h-64">
                    <Line
                      data={lineData}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                          y: { beginAtZero: true, grid: { color: '#f1f5f9' } },
                          x: { grid: { display: false } },
                        },
                      }}
                    />
                  </div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                  <h3 className="font-semibold text-slate-800 mb-4">Sessions by Hour</h3>
                  <div className="h-64">
                    <Bar
                      data={barData}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                          y: { beginAtZero: true, grid: { color: '#f1f5f9' } },
                          x: { grid: { display: false } },
                        },
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 max-w-md">
                <h3 className="font-semibold text-slate-800 mb-4">Resolution Rate</h3>
                <div className="h-56 flex items-center justify-center">
                  <Doughnut
                    data={donutData}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                        legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true } },
                      },
                    }}
                  />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
