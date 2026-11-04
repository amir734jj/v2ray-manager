import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, errorMessage } from './api.mjs';

export function useResource(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const response = await api.get(path);
      if (mounted.current && request === sequence.current) {
        setData(response.data);
        setError('');
      }
    } catch (failure) {
      if (mounted.current && request === sequence.current) {
        setError(`Refresh failed; displayed data may be stale. ${errorMessage(failure)}`);
      }
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    let timer;
    async function poll() {
      await refresh();
      if (mounted.current) timer = setTimeout(poll, 5000);
    }
    poll();
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  return { data, error, loading, refresh };
}
