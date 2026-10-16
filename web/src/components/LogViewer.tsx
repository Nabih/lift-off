import { useEffect, useRef, useState } from 'react';
import type { DeploymentStatus, LogLine } from '../types';

interface Props {
  deploymentId: string;
  initialStatus: DeploymentStatus;
}

const STREAM_LABEL: Record<LogLine['stream'], string> = {
  info: '',
  stdout: '',
  stderr: '!',
  error: '✕',
  success: '✓',
};

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Streams a deployment's build log over SSE and renders it terminal-style.
 * The server replays persisted lines first, so this works for finished builds
 * too.
 */
export default function LogViewer({ deploymentId, initialStatus }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<DeploymentStatus>(initialStatus);
  const [autoscroll, setAutoscroll] = useState(true);
  const [connected, setConnected] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setStatus(initialStatus);
    setConnected(false);

    const source = new EventSource(`/api/deployments/${deploymentId}/stream`);

    source.addEventListener('open', () => setConnected(true));

    source.addEventListener('log', (event) => {
      setConnected(true);
      try {
        const entry = JSON.parse((event as MessageEvent).data) as LogLine;
        setLines((previous) => [...previous, entry]);
      } catch {
        /* ignore malformed frame */
      }
    });

    source.addEventListener('end', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          status: DeploymentStatus;
        };
        setStatus(data.status);
      } catch {
        /* ignore malformed frame */
      }
      source.close();
      setConnected(false);
    });

    source.onerror = () => setConnected(false);

    return () => source.close();
  }, [deploymentId, initialStatus]);

  useEffect(() => {
    if (!autoscroll) return;
    const element = containerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, autoscroll]);

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <span className={`live-dot ${connected ? 'on' : 'off'}`} />
        <span className="muted small">
          {status === 'running' || status === 'queued'
            ? connected
              ? 'Streaming live output'
              : 'Connecting…'
            : 'Build finished'}
        </span>
        <span className="spacer" />
        <label className="checkbox small">
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(event) => setAutoscroll(event.target.checked)}
          />
          Auto-scroll
        </label>
      </div>

      <div
        className="log-body"
        ref={containerRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          if (atBottom !== autoscroll) setAutoscroll(atBottom);
        }}
      >
        {lines.length === 0 && <div className="log-line muted">No output yet…</div>}
        {lines.map((line, index) => (
          <div className={`log-line stream-${line.stream}`} key={line.seq ?? index}>
            <span className="log-time">{timeOf(line.ts)}</span>
            <span className="log-marker">{STREAM_LABEL[line.stream]}</span>
            <span className="log-text">{line.line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
