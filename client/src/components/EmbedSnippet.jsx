import { useState } from 'react';

export default function EmbedSnippet({ snippet }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!snippet) return;
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!snippet) {
    return (
      <p className="text-sm text-slate-500 italic">No embed key generated yet.</p>
    );
  }

  const highlighted = snippet
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/(src="[^"]+")/g, '<span class="text-emerald-400">$1</span>')
    .replace(/(data-bot="[^"]+")/g, '<span class="text-amber-300">$1</span>')
    .replace(/(&lt;script|&lt;\/script&gt;)/g, '<span class="text-sky-400">$1</span>');

  return (
    <div className="relative">
      <pre
        className="bg-slate-900 text-slate-100 rounded-lg p-4 text-sm overflow-x-auto font-mono leading-relaxed"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
      <button
        type="button"
        onClick={copy}
        className="absolute top-3 right-3 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-md transition-colors"
      >
        {copied ? 'Copied!' : 'Copy to clipboard'}
      </button>
    </div>
  );
}
