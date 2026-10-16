/**
 * Sliding-window rate limiter, in memory.
 *
 * Deliberately tiny: it exists to stop password-reset emails from being used to
 * spam a mailbox or hammer an SMTP server, not to be a general-purpose defence.
 * State is per process, so multiple instances would each keep their own window.
 */
const buckets = new Map<string, number[]>();

export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

/** Drops expired entries so the map cannot grow without bound. */
function sweep(): void {
  const now = Date.now();
  for (const [key, timestamps] of buckets) {
    const recent = timestamps.filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length === 0) buckets.delete(key);
    else buckets.set(key, recent);
  }
}

const timer = setInterval(sweep, 15 * 60 * 1000);
// Do not let housekeeping keep the process (or a test run) alive.
timer.unref();
