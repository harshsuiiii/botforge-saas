import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import BotSelector from '../components/BotSelector';
import TagInput from '../components/TagInput';
import EmbedSnippet from '../components/EmbedSnippet';

const DEFAULT_FALLBACK_MESSAGE = "I'm sorry, I couldn't find that in our catalog. Please contact us for help.";

const ANSWER_MODES = [
  { id: 'flexible', label: 'Flexible', desc: 'Answers general questions too, but never invents products or prices.' },
  { id: 'strict', label: 'Strict', desc: 'Only answers from your catalog.' },
];

const PERSONALITIES = [
  { id: 'friendly', label: 'Friendly', emoji: '😊' },
  { id: 'professional', label: 'Professional', emoji: '💼' },
  { id: 'concise', label: 'Concise', emoji: '⚡' },
  { id: 'expert', label: 'Expert', emoji: '🎓' },
];

export default function Settings() {
  const { apiJson } = useApi();
  const [botId, setBotId] = useState(null);
  const [name, setName] = useState('');
  const [personality, setPersonality] = useState('friendly');
  const [purpose, setPurpose] = useState('');
  const [instructions, setInstructions] = useState('');
  const [allowTopics, setAllowTopics] = useState([]);
  const [blockTopics, setBlockTopics] = useState([]);
  const [answerMode, setAnswerMode] = useState('flexible');
  const [fallbackMessage, setFallbackMessage] = useState('');
  const [embedSnippet, setEmbedSnippet] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!botId) return;

    setLoading(true);
    apiJson(`/api/bots/${botId}`)
      .then((data) => {
        const bot = data.bot;
        setName(bot.name || '');
        setPersonality(bot.personality || 'friendly');
        setPurpose(bot.purpose || '');
        setInstructions(bot.instructions || '');
        setAllowTopics(bot.topic_allow_list || []);
        setBlockTopics(bot.topic_block_list || []);
        setAnswerMode(bot.answer_mode || 'flexible');
        setFallbackMessage(bot.fallback_message || '');
        setEmbedSnippet(bot.embed_snippet || '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [botId, apiJson]);

  useEffect(() => {
    apiJson('/api/bots')
      .then((data) => {
        const bots = data.bots || [];
        if (bots.length && !botId) setBotId(bots[0].id);
      })
      .catch(() => {});
  }, [apiJson, botId]);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!botId) return;
    setSaving(true);
    try {
      await apiJson(`/api/bots/${botId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name,
          personality,
          purpose,
          instructions,
          topic_allow_list: allowTopics,
          topic_block_list: blockTopics,
          answer_mode: answerMode,
          fallback_message: fallbackMessage.trim() || null,
        }),
      });
      showToast('Settings saved successfully!');
    } catch (err) {
      showToast(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function regenerateEmbedKey() {
    if (!botId) return;
    try {
      const data = await apiJson(`/api/bots/${botId}/embed-key`, { method: 'POST' });
      setEmbedSnippet(data.embed_snippet);
      showToast('Embed key regenerated!');
    } catch (err) {
      showToast(err.message);
    }
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
          <p className="text-sm text-slate-500 mt-1">Edit your bot configuration</p>
        </div>
        <BotSelector
          selectedBotId={botId}
          onBotChange={setBotId}
          showAllOption={false}
        />
      </div>

      {toast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-3 bg-slate-900 text-white text-sm rounded-lg shadow-lg">
          {toast}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : !botId ? (
        <p className="text-slate-500">No bots found. Complete onboarding first.</p>
      ) : (
        <form onSubmit={handleSave} className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Bot name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Personality</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {PERSONALITIES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPersonality(p.id)}
                    className={`p-3 rounded-xl border-2 text-center transition-all ${
                      personality === p.id
                        ? 'border-indigo-600 bg-indigo-50'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <span className="text-xl">{p.emoji}</span>
                    <p className="text-xs font-medium mt-1">{p.label}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Purpose</label>
              <textarea
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                rows={3}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Additional instructions</label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={3}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Allowed topics</label>
              <TagInput tags={allowTopics} onChange={setAllowTopics} />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Blocked topics</label>
              <TagInput tags={blockTopics} onChange={setBlockTopics} variant="blocked" />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Answer mode</label>
              <div className="inline-flex rounded-lg border border-slate-300 p-1 bg-slate-50" role="radiogroup" aria-label="Answer mode">
                {ANSWER_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    role="radio"
                    aria-checked={answerMode === mode.id}
                    onClick={() => setAnswerMode(mode.id)}
                    className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                      answerMode === mode.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                {ANSWER_MODES.find((m) => m.id === answerMode)?.desc}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Fallback message</label>
              <textarea
                value={fallbackMessage}
                onChange={(e) => setFallbackMessage(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder={DEFAULT_FALLBACK_MESSAGE}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 resize-none"
              />
              <p className="text-xs text-slate-500 mt-1">
                What the bot says when your catalog has nothing relevant. Add contact details here.
              </p>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-slate-800">Embed snippet</h2>
              <button
                type="button"
                onClick={regenerateEmbedKey}
                className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
              >
                Regenerate embed key
              </button>
            </div>
            <EmbedSnippet snippet={embedSnippet} />
          </div>
        </form>
      )}
    </div>
  );
}
