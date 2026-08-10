import { Navigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useApi } from '../hooks/useApi';

export default function ProtectedRoute({ children, requireBots = true }) {
  const { isAuthenticated, loading } = useAuth();
  const { apiJson } = useApi();
  const location = useLocation();
  const [checking, setChecking] = useState(requireBots);
  const [hasBots, setHasBots] = useState(true);

  useEffect(() => {
    if (!isAuthenticated || !requireBots) {
      setChecking(false);
      return;
    }

    apiJson('/api/bots')
      .then((data) => setHasBots((data.bots || []).length > 0))
      .catch(() => setHasBots(false))
      .finally(() => setChecking(false));
  }, [isAuthenticated, requireBots, apiJson]);

  if (loading || checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (requireBots && !hasBots && location.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  return children;
}
