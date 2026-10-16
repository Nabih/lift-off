import { useEffect, useRef } from 'react';

/**
 * The standard error banner.
 *
 * Errors in Lift-Off are raised from whatever control the user just pressed —
 * often at the bottom of a long form or below the fold — so this scrolls the
 * message into view instead of leaving it off-screen.
 */
export default function ErrorAlert({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!message) return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [message]);

  if (!message) return null;

  return (
    <div className="alert error" ref={ref} role="alert">
      {message}
    </div>
  );
}