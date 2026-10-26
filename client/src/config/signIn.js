import { API_URL } from './api';

/**
 * Swap a single-use login code (from a sign-in redirect or dev sign-in) for
 * a JWT, store it, and route to onboarding or the dashboard.
 *
 * @returns {Promise<void>} rejects with a user-facing message on failure
 */
export async function completeSignIn(code, login, navigate) {
  const res = await fetch(`${API_URL}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sign-in failed. Please try again.');

  login(data.token, data.user);

  try {
    const botsRes = await fetch(`${API_URL}/api/bots`, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    const bots = await botsRes.json();
    navigate((bots.bots || []).length === 0 ? '/onboarding' : '/dashboard', { replace: true });
  } catch {
    navigate('/onboarding', { replace: true });
  }
}
