export default function StatCard({ label, value, trend, trendLabel }) {
  const trendUp = trend > 0;
  const trendDown = trend < 0;
  const trendNeutral = trend === 0 || trend == null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <div className="flex items-end justify-between mt-2">
        <p className="text-3xl font-bold text-slate-900">{value}</p>
        {!trendNeutral && (
          <div className={`flex items-center gap-1 text-sm font-medium ${trendUp ? 'text-emerald-600' : 'text-red-500'}`}>
            {trendUp ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
            <span>{Math.abs(trend).toFixed(1)}%</span>
          </div>
        )}
      </div>
      {trendLabel && <p className="text-xs text-slate-400 mt-1">{trendLabel}</p>}
    </div>
  );
}
