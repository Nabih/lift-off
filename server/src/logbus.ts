import { EventEmitter } from 'node:events';
import type { LogLine } from './types.js';

/**
 * In-process fan-out of live build output. Each deployment gets an emitter;
 * SSE subscribers attach to it. Everything is also persisted to SQLite by the
 * runner, so the emitter only needs to carry *new* lines.
 */
class LogBus {
  private channels = new Map<string, EventEmitter>();

  private channel(deploymentId: string): EventEmitter {
    let emitter = this.channels.get(deploymentId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.channels.set(deploymentId, emitter);
    }
    return emitter;
  }

  publish(deploymentId: string, entry: LogLine): void {
    this.channel(deploymentId).emit('line', entry);
  }

  /** Signals that the deployment reached a terminal state. */
  finish(deploymentId: string, status: string): void {
    const emitter = this.channels.get(deploymentId);
    if (!emitter) return;
    emitter.emit('done', status);
    // Give subscribers a tick to drain, then clean up.
    setTimeout(() => this.channels.delete(deploymentId), 30_000).unref?.();
  }

  subscribe(
    deploymentId: string,
    onLine: (entry: LogLine) => void,
    onDone: (status: string) => void,
  ): () => void {
    const emitter = this.channel(deploymentId);
    emitter.on('line', onLine);
    emitter.on('done', onDone);
    return () => {
      emitter.off('line', onLine);
      emitter.off('done', onDone);
    };
  }

  /** True while a deployment is running in this process. */
  isActive(deploymentId: string): boolean {
    return this.channels.has(deploymentId);
  }
}

export const logBus = new LogBus();
