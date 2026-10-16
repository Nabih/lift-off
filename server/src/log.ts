import { db } from './db.js';
import { MAX_LOG_LINES_PER_DEPLOYMENT } from './config.js';
import { logBus } from './logbus.js';
import type { LogLine } from './types.js';

export interface BuildLogger {
  info(message: string): void;
  success(message: string): void;
  error(message: string): void;
  stdout(line: string): void;
  stderr(line: string): void;
}

/**
 * Writes build output to SQLite (for history) and to the live log bus (for SSE
 * subscribers). Output is capped per deployment so a chatty build cannot fill
 * the disk.
 */
export function createBuildLogger(deploymentId: string): BuildLogger {
  let seq = 1;
  const insert = db.prepare(
    `INSERT INTO deployment_logs (deployment_id, seq, ts, stream, line)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const emit = (stream: LogLine['stream'], line: string): void => {
    if (seq > MAX_LOG_LINES_PER_DEPLOYMENT) return;
    const currentSeq = seq;
    const ts = new Date().toISOString();
    insert.run(deploymentId, currentSeq, ts, stream, line);
    seq += 1;
    logBus.publish(deploymentId, { seq: currentSeq, ts, stream, line });
  };

  return {
    info: (message) => emit('info', message),
    success: (message) => emit('success', message),
    error: (message) => emit('error', message),
    stdout: (line) => emit('stdout', line),
    stderr: (line) => emit('stderr', line),
  };
}
