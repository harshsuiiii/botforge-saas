import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { completeSignIn } from '../config/signIn';

export default function AuthCallback() {
  const [params] = useSearchParams();
  const { login } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false); // login codes work once; StrictMode runs effects twice

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const code = params.get('code');
    if (!code) {
      navigate('/login', { replace: true });
      return;
    }

    completeSignIn(code, login, navigate)
      .catch(() => navigate('/login?error=auth_failed', { replace: true }));
  }, [params, login, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
