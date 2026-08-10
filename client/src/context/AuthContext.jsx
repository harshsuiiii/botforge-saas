import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { API_URL } from '../config/api';

const AuthContext = createContext(null);
const TOKEN_KEY = 'bf_token';

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(!!localStorage.getItem(TOKEN_KEY));

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const login = useCallback((newToken, userData = null) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
    if (userData) setUser(userData);
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('unauthorized');
        const data = await res.json();
        if (!cancelled) setUser(data.user);
      } catch {
        if (!cancelled) logout();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [token, logout]);

  const value = useMemo(
    () => ({ user, token, login, logout, loading, isAuthenticated: !!token }),
    [user, token, login, logout, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
