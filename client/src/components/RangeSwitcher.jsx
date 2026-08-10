const RANGES = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
];

export default function RangeSwitcher({ value, onChange }) {
  return (
    <div className="inline-flex rounded-lg border border-slate-300 bg-white overflow-hidden">
      {RANGES.map((r) => (
        <button
          key={r.value}
          type="button"
          onClick={() => onChange(r.value)}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            value === r.value
              ? 'bg-indigo-600 text-white'
              : 'text-slate-600 hover:bg-slate-50'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
