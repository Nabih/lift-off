import type { DeploymentStatus } from '../types';

const LABELS: Record<DeploymentStatus, string> = {
  queued: 'Queued',
  running: 'Building',
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export default function StatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      {status === 'running' && <span className="pulse" />}
      {LABELS[status]}
    </span>
  );
}
