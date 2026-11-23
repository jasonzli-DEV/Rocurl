import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants as fsConstants, accessSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const READY_PATTERN = /Initialization Sequence Completed/i;
const UTUN_PATTERN = /Opened utun device (utun\d+)/i;
const FATAL_PATTERNS = [
  { regex: /AUTH_FAILED/i, message: 'Authentication failed (AUTH_FAILED)' },
  { regex: /Cannot open TUN\/TAP dev/i, message: 'Cannot open TUN/TAP device (try running with sudo)' },
  { regex: /Operation not permitted/i, message: 'Operation not permitted (root/sudo required)' },
  { regex: /Options error:\s*(.+)/i, message: null },
  { regex: /RESOLVE: Cannot resolve host address/i, message: 'Cannot resolve VPN server hostname' },
];
const GENERIC_FATAL_PATTERN = /Exiting due to fatal error/i;

const FALLBACK_OPENVPN_PATHS = [
  '/opt/homebrew/sbin/openvpn',
  '/usr/local/sbin/openvpn',
  '/usr/sbin/openvpn',
  '/sbin/openvpn',
  '/usr/local/bin/openvpn',
  '/usr/bin/openvpn',
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
  if (GENERIC_FATAL_PATTERN.test(line)) {
    return { type: 'fatal' };
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
 * Pick the most informative preceding error line from recent OpenVPN logs.
 * @param {string[]} recentLogs
 * @returns {string}
 */
export function extractFatalDetail(recentLogs) {
  for (let i = recentLogs.length - 1; i >= 0; i -= 1) {
    const line = recentLogs[i];
    if (!GENERIC_FATAL_PATTERN.test(line)) {
      return line;
    }
  }
  return 'OpenVPN exited due to a fatal error';
}

/**
 * Extract macOS utun device name from an OpenVPN log line.
 * @param {string} line
 * @returns {string | null}
 */
export function parseUtunDevice(line) {
  const match = line.match(UTUN_PATTERN);
  return match ? match[1] : null;
}

/**
 * Extract IPv4 address from `ip -4 -o addr show dev <dev>` output.
 * @param {string} output
 * @returns {string | null}
 */
export function parseIpv4FromIpAddr(output) {
  const match = String(output ?? '').match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return match ? match[1] : null;
}

/**
 * Resolve the full path to the `openvpn` binary so `sudo` doesn't fail on restricted PATHs.
 * @param {string} [explicitBin]
 * @returns {string}
 */
export function resolveOpenVpnBin(explicitBin) {
  if (explicitBin) return explicitBin;

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const whichRes = spawnSync(whichCmd, ['openvpn'], { encoding: 'utf8' });
  if (whichRes.status === 0 && whichRes.stdout) {
    const found = whichRes.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (found) return found;
  }

  for (const candidate of FALLBACK_OPENVPN_PATHS) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not present or not executable
    }
  }

  return 'openvpn';
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
 * @param {{
 *   profilePath: string,
 *   authFile: string,
 *   pidFile: string,
 *   useSudo: boolean,
 *   openvpnBin?: string,
 *   isolated?: boolean,
 *   slot?: number,
 *   platform?: string
 * }} params
 * @returns {{ command: string, args: string[], devName: string | null }}
 */
export function buildOpenVpnCommand({
  profilePath,
  authFile,
  pidFile,
  useSudo,
  openvpnBin = 'openvpn',
  isolated = false,
  slot = 0,
  platform = process.platform,
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

  let devName = null;
  if (isolated) {
    ovpnArgs.push('--route-noexec');
    if (platform === 'linux') {
      devName = `rocurl${slot}`;
      ovpnArgs.push('--dev', devName, '--dev-type', 'tun');
    } else if (platform === 'darwin') {
      ovpnArgs.push('--dev', 'utun');
    }
  }

  if (useSudo) {
    return {
      command: 'sudo',
      args: [openvpnBin, ...ovpnArgs],
      devName,
    };
  }

  return {
    command: openvpnBin,
    args: ovpnArgs,
    devName,
  };
}

/**
 * Run a system command synchronously, optionally via sudo.
 * @param {string} bin
 * @param {string[]} args
 * @param {boolean} useSudo
 */
function runNetCmd(bin, args, useSudo) {
  const cmd = useSudo ? 'sudo' : bin;
  const cmdArgs = useSudo ? [bin, ...args] : args;
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8' });
}

/**
 * Configure per-tunnel isolated routing so multiple VPNs can run concurrently without clobbering default routes.
 *
 * @param {{ devName: string | null, slot: number, useSudo: boolean, platform?: string }} params
 * @returns {{ curlInterface: string, cleanupRoute: () => void }}
 */
function setupIsolatedRouting({ devName, slot, useSudo, platform = process.platform }) {
  if (platform === 'linux') {
    if (!devName) {
      throw new Error('Missing Linux TUN device name for isolated routing.');
    }
    const addrRes = spawnSync('ip', ['-4', '-o', 'addr', 'show', 'dev', devName], { encoding: 'utf8' });
    const vpnIp = parseIpv4FromIpAddr(addrRes.stdout);
    if (!vpnIp) {
      throw new Error(`Could not determine IPv4 address for interface ${devName}.`);
    }

    const tableId = String(2000 + slot);
    const priority = String(10000 + slot);

    const routeRes = runNetCmd('ip', ['route', 'replace', 'default', 'dev', devName, 'table', tableId], useSudo);
    if (routeRes.status !== 0) {
      throw new Error(`Failed to add isolated route for ${devName}: ${(routeRes.stderr || '').trim()}`);
    }

    const ruleRes = runNetCmd(
      'ip',
      ['rule', 'add', 'from', `${vpnIp}/32`, 'table', tableId, 'priority', priority],
      useSudo,
    );
    if (ruleRes.status !== 0) {
      runNetCmd('ip', ['route', 'flush', 'table', tableId], useSudo);
      throw new Error(`Failed to add policy routing rule for ${vpnIp}: ${(ruleRes.stderr || '').trim()}`);
    }

    const cleanupRoute = () => {
      runNetCmd('ip', ['rule', 'del', 'from', `${vpnIp}/32`, 'table', tableId, 'priority', priority], useSudo);
      runNetCmd('ip', ['route', 'flush', 'table', tableId], useSudo);
    };

    return { curlInterface: vpnIp, cleanupRoute };
  }

  if (platform === 'darwin') {
    if (!devName) {
      throw new Error('Could not detect macOS utun device name from OpenVPN output.');
    }
    const routeRes = runNetCmd('route', ['add', '-ifscope', devName, 'default', '-interface', devName], useSudo);
    if (routeRes.status !== 0) {
      throw new Error(`Failed to add interface-scoped route for ${devName}: ${(routeRes.stderr || '').trim()}`);
    }

    const cleanupRoute = () => {
      runNetCmd('route', ['delete', '-ifscope', devName, 'default'], useSudo);
    };

    return { curlInterface: devName, cleanupRoute };
  }

  throw new Error(`Concurrent isolated routing is not supported on platform "${platform}".`);
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
 *   isolated?: boolean,
 *   slot?: number,
 *   platform?: string,
 *   onLog?: (line: string) => void
 * }} options
 * @returns {Promise<{ connectDurationMs: number, curlInterface: string | null, disconnect: () => Promise<void> }>}
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
    isolated = false,
    slot = 0,
    platform = process.platform,
    onLog,
  } = options;

  const pidFile = path.join(tempDir, `openvpn-${slot}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pid`);
  const { command, args, devName: fixedDevName } = buildOpenVpnCommand({
    profilePath,
    authFile,
    pidFile,
    useSudo,
    openvpnBin,
    isolated,
    slot,
    platform,
  });

  return new Promise((resolve, reject) => {
    const start = Date.now();
    let settled = false;
    let exited = false;
    let lastError = null;
    let detectedDevName = fixedDevName;
    let cleanupRoute = null;
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
      if (cleanupRoute) {
        const fn = cleanupRoute;
        cleanupRoute = null;
        try {
          fn();
        } catch {
          // Best-effort cleanup
        }
      }
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

        if (!detectedDevName) {
          const utun = parseUtunDevice(line);
          if (utun) detectedDevName = utun;
        }

        const event = parseOpenVpnLogLine(line);
        if (!event) continue;

        if (event.type === 'ready' && !settled) {
          let curlInterface = null;
          if (isolated) {
            try {
              const isolatedNet = setupIsolatedRouting({
                devName: detectedDevName,
                slot,
                useSudo,
                platform,
              });
              curlInterface = isolatedNet.curlInterface;
              cleanupRoute = isolatedNet.cleanupRoute;
            } catch (err) {
              fail(err.message);
              return;
            }
          }

          settled = true;
          clearTimeout(timer);
          resolve({
            connectDurationMs: Date.now() - start,
            curlInterface,
            disconnect,
          });
        } else if (event.type === 'error') {
          lastError = event.message;
          if (!settled) {
            fail(event.message);
          }
        } else if (event.type === 'fatal') {
          const detail = lastError ?? extractFatalDetail(recentLogs);
          lastError = detail;
          if (!settled) {
            fail(detail);
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
