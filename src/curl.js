import { spawn } from 'node:child_process';

/**
 * Execute curl with the given arguments and capture stdout, stderr, exit code, and duration.
 *
 * @param {string[]} curlArgs
 * @param {{ timeoutMs?: number, curlBin?: string }} [options]
 * @returns {Promise<{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, durationMs: number, timedOut: boolean }>}
 */
export function runCurl(curlArgs, options = {}) {
  const { timeoutMs, curlBin = 'curl' } = options;

  return new Promise((resolve, reject) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;

    const child = spawn(curlBin, curlArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 2000).unref();
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Failed to run "${curlBin}": ${err.message}`));
    });

    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}
