import { useEffect, useState } from 'react';

/**
 * Debounces a value for `delay` ms and returns the settled value alongside a
 * setter that applies immediately.
 *
 * Typing stays responsive because the input keeps its own local value; only the
 * settled value drives the request. The immediate setter is what makes a
 * "clear search" action safe: without it the settled value still holds the old
 * term and pushes it straight back into the URL a frame later.
 */
export function useDebounced<T>(
  value: T,
  delay: number,
): [T, (next: T) => void] {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return [settled, setSettled];
}

export default useDebounced;