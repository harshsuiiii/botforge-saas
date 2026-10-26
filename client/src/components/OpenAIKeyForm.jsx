import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';

/**
 * Connect, replace or disconnect the owner's OpenAI API key.
 * The key is sent once to the API, checked against OpenAI and stored encrypted;
 * the dashboard only ever sees a short hint such as "sk-…1234".
 */
export default function OpenAIKeyForm({ onChange, allowDisconnect = false }) {
  const { apiJson } = useApi();
  const [status, setStatus] = useState({ connected: false, key_hint: null });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiJson('/auth/openai/status')
      .then((data) => { setStatus(data); onChange?.(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [apiJson]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(next) {
    setStatus(next);
    onChange?.(next);
  }

  async function connect(e) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const data = await apiJson('/auth/openai/key', {
        method: 'POST',
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });
      update(data);
      setApiKey('');
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect OpenAI? Your bots will stop answering until you add a key again.')) return;
    setSaving(true);
    setError(null);
    try {
      await apiJson('/auth/openai/key', { method: 'DELETE' });
      update({ connected: false, key_hint: null });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Checking OpenAI connection…</p>;
  }

  if (status.connected && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-emerald-600 font-semibold">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Connected
        </span>
        <span className="font-mono text-xs text-slate-500">{status.key_hint}</span>
        <button type="button" onClick={() => setEditing(true)} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
          Replace key
        </button>
        {allowDisconnect && (
          <button type="button" onClick={disconnect} disabled={saving} className="text-sm text-red-600 hover:text-red-800 font-medium disabled:opacity-40">
            Disconnect
          </button>
        )}
        {error && <p className="w-full text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={connect} className="space-y-2">
      <label className="block text-sm font-medium text-slate-700" htmlFor="openai-key">OpenAI API key</label>
      <div className="flex flex-wrap gap-2">
        <input
          id="openai-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          className="flex-1 min-w-[220px] px-4 py-2.5 border border-slate-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-indigo-500"
        />
        <button
          type="submit"
          disabled={saving || !apiKey.trim()}
          className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
        >
          {saving ? 'Checking…' : 'Connect'}
        </button>
        {editing && (
          <button type="button" onClick={() => { setEditing(false); setError(null); }} className="text-sm text-slate-600 hover:text-slate-900">
            Cancel
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Create a key at platform.openai.com → API keys. It is stored encrypted and only used for your bots.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
