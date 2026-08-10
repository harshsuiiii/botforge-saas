import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { API_URL } from '../config/api';
import { useAuth } from '../context/AuthContext';
import { useApi } from '../hooks/useApi';
import TagInput from '../components/TagInput';
import EmbedSnippet from '../components/EmbedSnippet';

const PERSONALITIES = [
  { id: 'friendly', label: 'Friendly', emoji: '😊', desc: 'Warm and approachable' },
  { id: 'professional', label: 'Professional', emoji: '💼', desc: 'Formal and precise' },
  { id: 'concise', label: 'Concise', emoji: '⚡', desc: 'Brief and to the point' },
  { id: 'expert', label: 'Expert', emoji: '🎓', desc: 'Detailed and authoritative' },
];

function StepIndicator({ step }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {[1, 2, 3, 4].map((s) => (
        <div
          key={s}
          className={`h-2 rounded-full transition-all ${
            s === step ? 'w-8 bg-indigo-600' : s < step ? 'w-2 bg-indigo-400' : 'w-2 bg-slate-200'
          }`}
        />
      ))}
    </div>
  );
}

export default function Onboarding() {
  const [step, setStep] = useState(1);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { token } = useAuth();
  const { apiJson } = useApi();

  const [openaiConnected, setOpenaiConnected] = useState(false);
  const [spendCap, setSpendCap] = useState(20);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [name, setName] = useState('');
  const [personality, setPersonality] = useState('friendly');
  const [purpose, setPurpose] = useState('');
  const [instructions, setInstructions] = useState('');
  const [allowTopics, setAllowTopics] = useState([]);
  const [blockTopics, setBlockTopics] = useState([]);
  const [botId, setBotId] = useState(null);
  const [embedSnippet, setEmbedSnippet] = useState('');

  useEffect(() => {
    const openai = searchParams.get('openai');
    if (openai === 'connected') setOpenaiConnected(true);
    if (openai === 'error') setError('OpenAI connection failed. Please try again.');
  }, [searchParams]);

  useEffect(() => {
    if (!token) return;
    apiJson('/auth/openai/status')
      .then((data) => { if (data.connected) setOpenaiConnected(true); })
      .catch(() => {});
  }, [token, apiJson]);

  function connectOpenAI() {
    window.location.href = `${API_URL}/auth/openai?token=${encodeURIComponent(token)}`;
  }

  async function handleStep2Continue() {
    setSaving(true);
    setError(null);
    try {
      await apiJson('/auth/openai/spend-cap', {
        method: 'POST',
        body: JSON.stringify({ spend_cap: spendCap }),
      });
      setStep(3);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleStep3Continue() {
    if (!name.trim()) {
      setError('Bot name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = await apiJson('/api/bots', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          personality,
          purpose,
          instructions,
          topic_allow_list: allowTopics,
          topic_block_list: blockTopics,
          spend_cap: spendCap,
        }),
      });
      setBotId(data.bot.id);
      setStep(4);
      const embed = await apiJson(`/api/bots/${data.bot.id}/embed-key`, { method: 'POST' });
      setEmbedSnippet(embed.embed_snippet);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-100 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <StepIndicator step={step} />

        {step === 1 && (
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-10 text-center">
            <div className="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center mx-auto shadow-lg">
              <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7v1h1a2 2 0 110 4h-1v1a7 7 0 01-7 7h-2a7 7 0 01-7-7v-1H4a2 2 0 110-4h1v-1a7 7 0 017-7h1V5.73A2 2 0 0112 2z" />
              </svg>
            </div>
            <h1 className="mt-6 text-3xl font-bold text-slate-900">BotForge</h1>
            <p className="mt-3 text-lg text-slate-600">
              Set up your AI chat widget in 4 steps
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Connect OpenAI, configure your bot, and embed it on your site in minutes.
            </p>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="mt-8 px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition-colors"
            >
              Get Started
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
            <h2 className="text-2xl font-bold text-slate-900">Connect OpenAI</h2>
            <p className="mt-2 text-slate-500 text-sm">
              Link your OpenAI account so your bot can respond to visitors.
            </p>

            <div className="mt-6 p-4 border border-slate-200 rounded-xl">
              {openaiConnected ? (
                <div className="flex items-center gap-3 text-emerald-600">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="font-semibold">Connected</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={connectOpenAI}
                  className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-lg transition-colors"
                >
                  Connect OpenAI Account
                </button>
              )}
            </div>

            <div className="mt-6">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Monthly spend cap (USD)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={spendCap}
                  onChange={(e) => setSpendCap(Number(e.target.value))}
                  className="w-full pl-8 pr-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>

            {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

            <div className="mt-8 flex justify-between">
              <button type="button" onClick={() => setStep(1)} className="text-slate-600 hover:text-slate-900 text-sm font-medium">
                Back
              </button>
              <button
                type="button"
                onClick={handleStep2Continue}
                disabled={!openaiConnected || saving}
                className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors"
              >
                {saving ? 'Saving…' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
            <h2 className="text-2xl font-bold text-slate-900">Configure your bot</h2>
            <p className="mt-2 text-slate-500 text-sm">Tell us how your bot should behave.</p>

            <div className="mt-6 space-y-5">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Bot name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Support Bot"
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Personality</label>
                <div className="grid grid-cols-2 gap-3">
                  {PERSONALITIES.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPersonality(p.id)}
                      className={`p-4 rounded-xl border-2 text-left transition-all ${
                        personality === p.id
                          ? 'border-indigo-600 bg-indigo-50'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <span className="text-2xl">{p.emoji}</span>
                      <p className="font-semibold text-slate-900 mt-1">{p.label}</p>
                      <p className="text-xs text-slate-500">{p.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Purpose</label>
                <textarea
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="e.g. Answer customer support questions about our SaaS product"
                  rows={3}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Additional instructions</label>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="e.g. Always recommend upgrading to Pro when relevant"
                  rows={3}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Allowed topics</label>
                <TagInput tags={allowTopics} onChange={setAllowTopics} placeholder="billing, refunds…" />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Blocked topics</label>
                <TagInput tags={blockTopics} onChange={setBlockTopics} variant="blocked" placeholder="competitors, legal…" />
              </div>
            </div>

            {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

            <div className="mt-8 flex justify-between">
              <button type="button" onClick={() => setStep(2)} className="text-slate-600 hover:text-slate-900 text-sm font-medium">
                Back
              </button>
              <button
                type="button"
                onClick={handleStep3Continue}
                disabled={saving}
                className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-lg"
              >
                {saving ? 'Creating…' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
            <h2 className="text-2xl font-bold text-slate-900">Get embed code</h2>
            <p className="mt-2 text-slate-500 text-sm">
              Paste this snippet before the closing <code className="text-xs bg-slate-100 px-1 rounded">&lt;/body&gt;</code> tag on your site.
            </p>

            <div className="mt-6">
              <EmbedSnippet snippet={embedSnippet} />
            </div>

            <div className="mt-8 flex justify-center">
              <div className="relative">
                <div className="w-16 h-16 rounded-full bg-indigo-600 shadow-lg flex items-center justify-center">
                  <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <div className="absolute -top-20 -right-24 w-56 h-32 bg-white rounded-xl shadow-xl border border-slate-200 p-3 hidden sm:block">
                  <p className="text-xs text-slate-500">Preview</p>
                  <p className="text-sm text-slate-800 mt-1">Hi! How can I help you today?</p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="mt-8 w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition-colors"
            >
              Go to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
