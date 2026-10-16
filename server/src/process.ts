import { execa } from 'execa';

export interface StreamRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Run the command through a shell (needed for `npm run build && ...`). */
  shell?: boolean;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  timeoutMs?: number;
}

export interface StreamRunResult {
  exitCode: number;
  signal?: string;
  timedOut: boolean;
}

/** Accumulates chunks and emits complete lines, so output stays readable. */
function lineSplitter(onLine?: (line: string) => void) {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        onLine?.(line);
        index = buffer.indexOf('\n');
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        onLine?.(buffer.replace(/\r$/, ''));
        buffer = '';
      }
    },
  };
}

/**
 * Runs a command, streaming stdout/stderr line by line. Never rejects on a
 * non-zero exit code — the caller decides what a failure means.
 */
export async function runStreaming(
  file: string,
  args: string[],
  options: StreamRunOptions,
): Promise<StreamRunResult> {
  const subprocess = execa(file, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell ?? false,
    reject: false,
    buffer: false,
    timeout: options.timeoutMs,
    stripFinalNewline: false,
  });

  const stdout = lineSplitter(options.onStdout);
  const stderr = lineSplitter(options.onStderr);

  subprocess.stdout?.on('data', (chunk: Buffer | string) =>
    stdout.push(chunk.toString()),
  );
  subprocess.stderr?.on('data', (chunk: Buffer | string) =>
    stderr.push(chunk.toString()),
  );

  const result = await subprocess;
  stdout.flush();
  stderr.flush();

  return {
    exitCode: result.exitCode ?? (result.signal ? 1 : 0),
    signal: result.signal ?? undefined,
    timedOut: Boolean(result.timedOut),
  };
}

/** Runs a command and buffers its output. Rejects on non-zero exit. */
export async function capture(
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  const result = await execa(file, args, {
    cwd: options.cwd,
    env: options.env,
    reject: true,
    timeout: options.timeoutMs,
  });
  return result.stdout;
}
