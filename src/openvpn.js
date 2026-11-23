import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const READY_PATTERN = /Initialization Sequence Completed/i;
const FATAL_PATTERNS = [
  { regex: /AUTH_FAILED/i, message: 'Authentication failed (AUTH_FAILED)' },
  { regex: /Cannot open TUN\/TAP dev/i, message: 'Cannot open TUN/TAP device (try running with sudo)' },
  { regex: /Operation not permitted/i, message: 'Operation not permitted (root/sudo required)' },
  { regex: /Options error:\s*(.+)/i, message: null },
  { regex: /Exiting due to fatal error/i, message: 'OpenVPN exited due to a fatal error' },
  { regex: /RESOLVE: Cannot resolve host address/i, message: 'Cannot resolve VPN server hostname' },
];

/**
 * Inspect a line of OpenVPN log output for connection readiness or fatal errors.
 *
 * @param {string} line
 * @returns {{ type: 'ready' } | { type: 'error', message: string } | null}
 */
export function parseOpenVpnLogLine(line) {
  if (READY_PATTERN.test(line)) {
    return { type: 'ready' };
  }
  for (const pattern of FATAL_PATTERNS) {
    const match = line.match(pattern.regex);
    if (match) {
      return {
        type: 'error',
        message: pattern.message ?? match[0].trim(),
      };
    }
  }
  return null;
}

/**
 * Check whether sudo is needed on this platform.
 * @param {boolean} noSudo
 * @returns {boolean}
 */
export function needsSudo(noSudo = false) {
  if (noSudo) return false;
  if (process.platform === 'win32') return false;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return false;
  return true;
}

/**
 * Refresh sudo credentials interactively before launching background OpenVPN processes.
 */
export function ensureSudoAuth() {
  const result = spawnSync('sudo', ['-v'], { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`Failed to invoke sudo: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error('sudo authentication failed.');
  }
}

/**
 * Create a secure temporary directory and auth-user-pass file with 0600 permissions.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ tempDir: string, authFile: string, cleanup: () => Promise<void> }>}
 */
export async function createAuthFile(username, password) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rocurl-'));
  await fs.chmod(tempDir, 0o700).catch(() => {});
  const authFile = path.join(tempDir, 'auth.txt');
  await fs.writeFile(authFile, `${username}\n${password}\n`, { mode: 0o600 });

  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  return { tempDir, authFile, cleanup };
}

/**
 * Build OpenVPN command and arguments for a profile.
 *
 * @param {{ profilePath: string, authFile: string, pidFile: string, useSudo: boolean, openvpnBin?: string }} params
 * @returns {{ command: string, args: string[] }}
 */
export function buildOpenVpnCommand({
  profilePath,
  authFile,
  pidFile,
  useSudo,
  openvpnBin = 'openvpn',
}) {
  const absProfile = path.resolve(profilePath);
  const profileDir = path.dirname(absProfile);
  const ovpnArgs = [
    '--cd', profileDir,
    '--config', absProfile,
    '--auth-user-pass', path.resolve(authFile),
    '--auth-nocache',
    '--auth-retry', 'nointeract',
    '--writepid', path.resolve(pidFile),
  ];

  if (useSudo) {
    return {
      command: 'sudo',
      args: [openvpnBin, ...ovpnArgs],
    };
  }

  return {
    command: openvpnBin,
    args: ovpnArgs,
  };
}

/**
 * Read a numeric PID from a pidfile if it exists.
 * @param {string} pidFile
 * @returns {Promise<number | null>}
 */
async function readPidFile(pidFile) {
  try {
    const content = (await fs.readFile(pidFile, 'utf8')).trim();
    const pid = Number.parseInt(content, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Send a signal to a process, using sudo if needed.
 * @param {number} pid
 * @param {'TERM' | 'KILL'} signal
 * @param {boolean} useSudo
 */
function signalProcess(pid, signal, useSudo) {
  if (useSudo) {
    spawnSync('sudo', ['kill', `-${signal}`, String(pid)], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, `SIG${signal}`);
    } catch {
      // Process may already have exited
    }
  }
}

/**
 * Connect to an OpenVPN profile and return a handle to disconnect cleanly.
 *
 * @param {{
 *   profilePath: string,
 *   authFile: string,
 *   tempDir: string,
 *   useSudo: boolean,
 *   timeoutMs: number,
 *   verbose?: boolean,
 *   openvpnBin?: string,
 *   onLog?: (line: string) => void
 * }} options
 * @returns {Promise<{ connectDurationMs: number, disconnect: () => Promise<void> }>}
 */
export function connectOpenVpn(options) {
  const {
    profilePath,
    authFile,
    tempDir,
    useSudo,
    timeoutMs,
    verbose = false,
    openvpnBin = 'openvpn',
    onLog,
  } = options;

  const pidFile = path.join(tempDir, `openvpn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pid`);
  const { command, args } = buildOpenVpnCommand({
    profilePath,
    authFile,
    pidFile,
    useSudo,
    openvpnBin,
  });

  return new Promise((resolve, reject) => {
    const start = Date.now();
    let settled = false;
    let exited = false;
    let lastError = null;
    const recentLogs = [];

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const waitForExit = (waitMs = 5000) =>
      new Promise((done) => {
        if (exited) {
          done(true);
          return;
        }
        const t = setTimeout(() => done(false), waitMs);
        child.once('close', () => {
          clearTimeout(t);
          done(true);
        });
      });

    const disconnect = async () => {
      if (!exited) {
        const pid = (await readPidFile(pidFile)) ?? child.pid;
        if (pid) {
          signalProcess(pid, 'TERM', useSudo);
        }
        const stopped = await waitForExit(5000);
        if (!stopped) {
          const killPid = (await readPidFile(pidFile)) ?? child.pid;
          if (killPid) {
            signalProcess(killPid, 'KILL', useSudo);
          }
          await waitForExit(2000);
        }
      }
      await fs.rm(pidFile, { force: true }).catch(() => {});
    };

    const fail = async (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await disconnect();
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      fail(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for OpenVPN to connect`);
    }, timeoutMs);

    const handleChunk = (chunk) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        recentLogs.push(line);
        if (recentLogs.length > 20) recentLogs.shift();

        if (verbose && onLog) {
          onLog(line);
        }

        const event = parseOpenVpnLogLine(line);
        if (!event) continue;

        if (event.type === 'ready' && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            connectDurationMs: Date.now() - start,
            disconnect,
          });
        } else if (event.type === 'error') {
          lastError = event.message;
          if (!settled) {
            fail(event.message);
          }
        }
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('error', (err) => {
      exited = true;
      fail(`Failed to start "${command}": ${err.message}`);
    });

    child.on('close', (code, signal) => {
      exited = true;
      if (!settled) {
        const detail = lastError
          ?? (recentLogs.length > 0 ? recentLogs[recentLogs.length - 1] : `exit code ${code ?? signal}`);
        fail(`OpenVPN exited before connecting (${detail})`);
      }
    });
  });
}
