import { useEffect, useState } from 'react';
import { useApi } from './useApi';

const RETRY_DELAYS_MS = [500, 1500, 4000];

/**
 * The signed-in user's bots, retried a few times so a single failed request
 * (e.g. the API still starting) doesn't leave a page saying "No bots found".
 */
export function useBots() {
  const { apiJson } = useApi();
  const [state, setState] = useState({ bots: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    let timer;

    const attempt = (n) => {
      apiJson('/api/bots')
        .then((data) => { if (!cancelled) setState({ bots: data.bots || [], loading: false, error: null }); })
        .catch((err) => {
          if (cancelled) return;
          if (n < RETRY_DELAYS_MS.length) {
            timer = setTimeout(() => attempt(n + 1), RETRY_DELAYS_MS[n]);
          } else {
            setState({ bots: [], loading: false, error: err.message });
          }
        });
    };
    attempt(0);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [apiJson]);

  return state;
}
