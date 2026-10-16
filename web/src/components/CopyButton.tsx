import { useState } from 'react';
import { copyToClipboard } from '../format';

interface Props {
  value: string;
  label?: string;
  className?: string;
}

export default function CopyButton({ value, label = 'Copy', className }: Props) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={className ?? 'btn small'}
      onClick={async () => {
        const ok = await copyToClipboard(value);
        setCopied(ok);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
