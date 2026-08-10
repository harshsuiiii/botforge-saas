import { useState } from 'react';

export default function TagInput({ tags, onChange, variant = 'default', placeholder = 'Type and press Enter' }) {
  const [input, setInput] = useState('');

  const chipClass = variant === 'blocked'
    ? 'bg-red-100 text-red-700 border-red-200'
    : 'bg-indigo-100 text-indigo-700 border-indigo-200';

  function addTag(value) {
    const trimmed = value.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
    setInput('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(input);
    }
    if (e.key === 'Backspace' && !input && tags.length) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap gap-2 p-3 border border-slate-300 rounded-lg bg-white min-h-[48px] focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-indigo-500">
      {tags.map((tag) => (
        <span
          key={tag}
          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm border ${chipClass}`}
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="hover:opacity-70"
            aria-label={`Remove ${tag}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => input && addTag(input)}
        placeholder={tags.length ? '' : placeholder}
        className="flex-1 min-w-[120px] outline-none text-sm bg-transparent"
      />
    </div>
  );
}
