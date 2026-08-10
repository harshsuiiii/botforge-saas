import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi';

export default function BotSelector({ selectedBotId, onBotChange, showAllOption = true }) {
  const { apiJson } = useApi();
  const navigate = useNavigate();
  const { id: routeBotId } = useParams();
  const [bots, setBots] = useState([]);
  const [loading, setLoading] = useState(true);

  const value = selectedBotId ?? routeBotId ?? '';

  useEffect(() => {
    apiJson('/api/bots')
      .then((data) => setBots(data.bots || []))
      .catch(() => setBots([]))
      .finally(() => setLoading(false));
  }, [apiJson]);

  function handleChange(e) {
    const botId = e.target.value;
    onBotChange?.(botId || null);
    if (routeBotId !== undefined) {
      if (botId) navigate(`/dashboard/bots/${botId}`);
      else navigate('/dashboard');
    }
  }

  return (
    <select
      value={value}
      onChange={handleChange}
      disabled={loading}
      className="px-3 py-2 border border-slate-300 rounded-lg bg-white text-sm font-medium text-slate-700 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
    >
      {showAllOption && <option value="">All bots</option>}
      {bots.map((bot) => (
        <option key={bot.id} value={bot.id}>{bot.name}</option>
      ))}
    </select>
  );
}
