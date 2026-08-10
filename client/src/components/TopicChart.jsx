import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import EmptyState from './EmptyState';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

export default function TopicChart({ title, data, emptyMessage, color = '#6366f1' }) {
  const hasData = data && data.length > 0;

  if (!hasData) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800">{title}</h3>
        </div>
        <EmptyState title="No data yet" message={emptyMessage} icon="chart" />
      </div>
    );
  }

  const chartData = {
    labels: data.map((d) => d.topic),
    datasets: [{
      label: 'Count',
      data: data.map((d) => d.count),
      backgroundColor: color,
      borderRadius: 4,
    }],
  };

  const options = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: { display: false },
    },
    scales: {
      x: { beginAtZero: true, grid: { color: '#f1f5f9' } },
      y: { grid: { display: false } },
    },
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
      <div className="px-5 py-4 border-b border-slate-100">
        <h3 className="font-semibold text-slate-800">{title}</h3>
      </div>
      <div className="p-4 h-80">
        <Bar data={chartData} options={options} />
      </div>
    </div>
  );
}
