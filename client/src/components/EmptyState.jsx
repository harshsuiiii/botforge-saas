export default function EmptyState({ title, message, icon = 'chart' }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      {icon === 'chart' && (
        <svg className="w-20 h-20 text-slate-300 mb-4" viewBox="0 0 80 80" fill="none" aria-hidden="true">
          <rect x="10" y="45" width="12" height="25" rx="2" fill="currentColor" />
          <rect x="34" y="30" width="12" height="40" rx="2" fill="currentColor" />
          <rect x="58" y="18" width="12" height="52" rx="2" fill="currentColor" />
          <path d="M8 72h64" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      {icon === 'chat' && (
        <svg className="w-20 h-20 text-slate-300 mb-4" viewBox="0 0 80 80" fill="none" aria-hidden="true">
          <rect x="12" y="16" width="56" height="40" rx="8" stroke="currentColor" strokeWidth="3" />
          <path d="M28 56l-8 12 4-12" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
          <circle cx="32" cy="36" r="3" fill="currentColor" />
          <circle cx="40" cy="36" r="3" fill="currentColor" />
          <circle cx="48" cy="36" r="3" fill="currentColor" />
        </svg>
      )}
      {icon === 'table' && (
        <svg className="w-20 h-20 text-slate-300 mb-4" viewBox="0 0 80 80" fill="none" aria-hidden="true">
          <rect x="10" y="18" width="60" height="44" rx="4" stroke="currentColor" strokeWidth="3" />
          <path d="M10 32h60M30 18v44" stroke="currentColor" strokeWidth="2" />
        </svg>
      )}
      <h3 className="text-lg font-semibold text-slate-700">{title}</h3>
      <p className="text-sm text-slate-500 mt-1 max-w-sm">{message}</p>
    </div>
  );
}
