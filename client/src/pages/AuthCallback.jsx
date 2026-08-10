import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { API_URL } from '../config/api';
import { useAuth } from '../context/AuthContext';

export default function AuthCallback() {
  const [params] = useSearchParams();
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const token = params.get('token');
    const email = params.get('email');

    if (!token) {
      navigate('/login', { replace: true });
      return;
    }

    login(token, email ? { email } : null);

    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/bots`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if ((data.bots || []).length === 0) {
          navigate('/onboarding', { replace: true });
        } else {
          navigate('/dashboard', { replace: true });
        }
      } catch {
        navigate('/onboarding', { replace: true });
      }
    })();
  }, [params, login, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
