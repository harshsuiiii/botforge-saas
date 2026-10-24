import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV = [
  { to: '/dashboard', label: 'Overview', end: true },
  { to: '/dashboard/logs', label: 'Chat Logs' },
  { to: '/dashboard/topics', label: 'Topics' },
  { to: '/dashboard/catalog', label: 'Catalog' },
  { to: '/dashboard/settings', label: 'Settings' },
];

function BotForgeLogo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
        <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7v1h1a2 2 0 110 4h-1v1a7 7 0 01-7 7h-2a7 7 0 01-7-7v-1H4a2 2 0 110-4h1v-1a7 7 0 017-7h1V5.73A2 2 0 0112 2z" />
        </svg>
      </div>
      <span className="font-bold text-lg text-slate-900">BotForge</span>
    </div>
  );
}

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-5 border-b border-slate-100">
          <BotForgeLogo />
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-50'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-slate-100">
          <p className="text-xs text-slate-500 truncate">{user?.email}</p>
          <button
            type="button"
            onClick={handleLogout}
            className="mt-2 text-sm text-slate-600 hover:text-red-600 transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
