import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_URL } from '../config/api';
import { useAuth } from '../context/AuthContext';

export function useApi() {
  const { token, logout } = useAuth();
  const navigate = useNavigate();

  const apiFetch = useCallback(async (path, options = {}) => {
    const headers = {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    };

    const res = await fetch(`${API_URL}${path}`, { ...options, headers });

    if (res.status === 401) {
      logout();
      navigate('/login');
      throw new Error('Unauthorized');
    }

    return res;
  }, [token, logout, navigate]);

  const apiJson = useCallback(async (path, options = {}) => {
    const res = await apiFetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }, [apiFetch]);

  return { apiFetch, apiJson };
}
