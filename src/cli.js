import path from 'node:path';
import { discoverProfiles } from './profiles.js';
import { getCredentials } from './prompt.js';
import {
  connectOpenVpn,
  createAuthFile,
  ensureSudoAuth,
  needsSudo,
  resolveOpenVpnBin,
} from './openvpn.js';
import { runCurl } from './curl.js';
import { formatDuration, formatPreview, formatSummary } from './summary.js';

export const DEFAULT_CONCURRENCY = process.platform === 'win32' ? 1 : 5;

export const HELP_TEXT = `
rocurl - Run a curl command through every OpenVPN (.ovpn) profile in a folder

Usage:
  npx rocurl [rocurl-options] [curl] <curl-args...>
  npx rocurl [rocurl-options] -- <curl-args...>

Examples:
  npx rocurl curl https://api.ipify.org
  npx rocurl --concurrency 10 curl -s https://ipinfo.io/json
  npx rocurl --dir ./vpns curl -s -H "Accept: application/json" https://api.ipify.org?format=json

Rocurl Options (must appear before the curl command):
  --dir <path>           Directory containing .ovpn files (default: current directory)
  --concurrency <n>      Number of VPN profiles to run in parallel (default: ${DEFAULT_CONCURRENCY}; use 1 for sequential)
  --timeout <seconds>    OpenVPN connection timeout in seconds (default: 30)
  --curl-timeout <secs>  Maximum seconds to wait for each curl command (default: none)
  --openvpn-bin <path>   Path to the openvpn binary (default: auto-detected)
  --user <username>      OpenVPN username (or set ROCURL_USER env var)
  --pass <password>      OpenVPN password (or set ROCURL_PASS env var)
  --no-sudo              Do not invoke openvpn via sudo
  --verbose              Print OpenVPN logs while connecting
  --dry-run              List discovered .ovpn profiles and curl args without connecting
  -h, --help             Show this help message
`.trim();

/**
 * Parse CLI arguments into rocurl options and curl arguments.
 * Option parsing stops at `--`, `curl`, or the first non-rocurl argument so curl flags are never stolen.
 *
 * @param {string[]} argv
 * @returns {{
 *   help: boolean,
 *   dir: string,
 *   concurrency: number,
 *   timeoutSec: number,
 *   curlTimeoutSec: number | null,
 *   openvpnBin?: string,
 *   user?: string,
 *   pass?: string,
 *   noSudo: boolean,
 *   verbose: boolean,
 *   dryRun: boolean,
 *   curlArgs: string[]
 * }}
 */
export function parseArgs(argv) {
  const options = {
    help: false,
    dir: process.cwd(),
    concurrency: DEFAULT_CONCURRENCY,
    timeoutSec: 30,
    curlTimeoutSec: null,
    openvpnBin: undefined,
    user: undefined,
    pass: undefined,
    noSudo: false,
    verbose: false,
    dryRun: false,
    curlArgs: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--') {
      i += 1;
      break;
    }

    if (arg === 'curl') {
      i += 1;
      break;
    }

    if (arg === '-h' || arg === '--help') {
      options.help = true;
      return options;
    }

    if (arg === '--dir') {
      const value = argv[i + 1];
      if (!value) throw new Error('--dir requires a path argument.');
      options.dir = value;
      i += 2;
      continue;
    }

    if (arg === '--concurrency') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--concurrency requires a positive integer.');
      }
      options.concurrency = value;
      i += 2;
      continue;
    }

    if (arg === '--timeout') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--timeout requires a positive number of seconds.');
      }
      options.timeoutSec = value;
      i += 2;
      continue;
    }

    if (arg === '--curl-timeout') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--curl-timeout requires a positive number of seconds.');
      }
      options.curlTimeoutSec = value;
      i += 2;
      continue;
    }

    if (arg === '--openvpn-bin') {
      const value = argv[i + 1];
      if (!value) throw new Error('--openvpn-bin requires a file path.');
      options.openvpnBin = value;
      i += 2;
      continue;
    }

    if (arg === '--user') {
      const value = argv[i + 1];
      if (!value) throw new Error('--user requires a username.');
      options.user = value;
      i += 2;
      continue;
    }

    if (arg === '--pass') {
      const value = argv[i + 1];
      if (!value) throw new Error('--pass requires a password.');
      options.pass = value;
      i += 2;
      continue;
    }

    if (arg === '--no-sudo') {
      options.noSudo = true;
      i += 1;
      continue;
    }

    if (arg === '--verbose') {
      options.verbose = true;
      i += 1;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      i += 1;
      continue;
    }

    // Any other token starts the curl command arguments.
    break;
  }

  let remaining = argv.slice(i);
  if (remaining[0] === 'curl') {
    remaining = remaining.slice(1);
  }
  options.curlArgs = remaining;

  return options;
}

/**
 * Run an async worker function over an array with bounded concurrency, preserving result order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number, slot: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, (_, slot) =>
    (async () => {
      while (true) {
        const index = nextIndex;
        if (index >= items.length) break;
        nextIndex += 1;
        results[index] = await worker(items[index], index, slot);
      }
    })(),
  );

  await Promise.all(workers);
  return results;
}

/**
 * Inject `--interface <iface>` into curl args unless the user already passed `--interface`.
 *
 * @param {string[]} curlArgs
 * @param {string | null} curlInterface
 * @returns {string[]}
 */
export function withCurlInterface(curlArgs, curlInterface) {
  if (!curlInterface) return curlArgs;
  const hasInterface = curlArgs.some((a) => a === '--interface' || a.startsWith('--interface='));
  if (hasInterface) return curlArgs;
  return ['--interface', curlInterface, ...curlArgs];
}

/**
 * Main CLI entrypoint.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error('Run "rocurl --help" for usage.');
    return 1;
  }

  if (options.help || options.curlArgs.length === 0) {
    console.log(HELP_TEXT);
    return options.help ? 0 : 1;
  }

  let profiles;
  try {
    profiles = await discoverProfiles(options.dir);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }

  if (profiles.length === 0) {
    console.error(`No .ovpn files found in "${path.resolve(options.dir)}".`);
    return 1;
  }

  let effectiveConcurrency = Math.min(options.concurrency, profiles.length);
  if (effectiveConcurrency > 1 && process.platform !== 'linux' && process.platform !== 'darwin') {
    console.warn(`Warning: Concurrent mode is only supported on Linux and macOS; falling back to --concurrency 1.`);
    effectiveConcurrency = 1;
  }

  const isolated = effectiveConcurrency > 1;
  const openvpnBin = resolveOpenVpnBin(options.openvpnBin);

  console.log(
    `Found ${profiles.length} OpenVPN profile${profiles.length === 1 ? '' : 's'} in ${path.resolve(options.dir)} (concurrency: ${effectiveConcurrency}).`,
  );

  if (options.dryRun) {
    console.log(`OpenVPN binary: ${openvpnBin}`);
    console.log(`Curl command: curl ${options.curlArgs.join(' ')}`);
    for (const [idx, p] of profiles.entries()) {
      console.log(`  [${idx + 1}/${profiles.length}] ${p.name}`);
    }
    return 0;
  }

  let credentials;
  try {
    credentials = await getCredentials({
      user: options.user,
      pass: options.pass,
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }

  const useSudo = needsSudo(options.noSudo);
  if (useSudo) {
    console.log('OpenVPN requires elevated privileges. Requesting sudo access...');
    try {
      ensureSudoAuth();
    } catch (err) {
      console.error(`Error: ${err.message}`);
      return 1;
    }
  }

  const auth = await createAuthFile(credentials.username, credentials.password);
  const completedResults = [];
  const overallStart = Date.now();
  const activeDisconnects = new Set();
  let interrupted = false;

  const handleInterrupt = async (signal) => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\nReceived ${signal}. Cleaning up ${activeDisconnects.size} active VPN connection(s)...`);
    await Promise.all([...activeDisconnects].map((fn) => fn().catch(() => {})));
    activeDisconnects.clear();
    await auth.cleanup();
    if (completedResults.length > 0) {
      console.log(formatSummary(completedResults, Date.now() - overallStart));
    }
    process.exit(130);
  };

  process.on('SIGINT', handleInterrupt);
  process.on('SIGTERM', handleInterrupt);

  let results = [];
  try {
    results = await runWithConcurrency(profiles, effectiveConcurrency, async (profile, index, slot) => {
      if (interrupted) {
        return {
          profile: profile.name,
          status: 'skipped',
          error: 'Interrupted',
        };
      }

      const prefix = `[${index + 1}/${profiles.length}] ${profile.name}`;
      console.log(`${prefix} — Connecting...`);

      let vpn = null;
      try {
        vpn = await connectOpenVpn({
          profilePath: profile.filePath,
          authFile: auth.authFile,
          tempDir: auth.tempDir,
          useSudo,
          timeoutMs: options.timeoutSec * 1000,
          verbose: options.verbose,
          openvpnBin,
          isolated,
          slot,
          onLog: (line) => console.log(`  [${profile.name}] ${line}`),
        });
        activeDisconnects.add(vpn.disconnect);
      } catch (err) {
        console.error(`${prefix} — VPN failed: ${err.message}`);
        const res = {
          profile: profile.name,
          status: 'vpn_error',
          connectDurationMs: null,
          curlDurationMs: null,
          curlExitCode: null,
          error: err.message,
        };
        completedResults.push(res);
        return res;
      }

      console.log(`${prefix} — Connected (${formatDuration(vpn.connectDurationMs)}). Running curl...`);

      try {
        const finalCurlArgs = withCurlInterface(options.curlArgs, vpn.curlInterface);
        const curlResult = await runCurl(finalCurlArgs, {
          timeoutMs: options.curlTimeoutSec ? options.curlTimeoutSec * 1000 : undefined,
        });

        const ok = !curlResult.timedOut && curlResult.exitCode === 0;
        if (ok) {
          console.log(`${prefix} — Done (${formatDuration(curlResult.durationMs)}): ${formatPreview(curlResult.stdout, 100)}`);
        } else {
          const reason = curlResult.timedOut
            ? `Timed out after ${options.curlTimeoutSec}s`
            : `Exit code ${curlResult.exitCode}${curlResult.stderr ? `: ${formatPreview(curlResult.stderr, 80)}` : ''}`;
          console.error(`${prefix} — Curl failed (${reason})`);
        }

        const res = {
          profile: profile.name,
          status: ok ? 'ok' : 'curl_error',
          connectDurationMs: vpn.connectDurationMs,
          curlDurationMs: curlResult.durationMs,
          curlExitCode: curlResult.exitCode,
          stdout: curlResult.stdout,
          stderr: curlResult.stderr,
          error: curlResult.timedOut ? `Curl timed out after ${options.curlTimeoutSec}s` : undefined,
        };
        completedResults.push(res);
        return res;
      } catch (err) {
        console.error(`${prefix} — Curl error: ${err.message}`);
        const res = {
          profile: profile.name,
          status: 'curl_error',
          connectDurationMs: vpn.connectDurationMs,
          curlDurationMs: null,
          curlExitCode: null,
          error: err.message,
        };
        completedResults.push(res);
        return res;
      } finally {
        activeDisconnects.delete(vpn.disconnect);
        await vpn.disconnect();
      }
    });
  } finally {
    process.removeListener('SIGINT', handleInterrupt);
    process.removeListener('SIGTERM', handleInterrupt);
    await auth.cleanup();
  }

  console.log(formatSummary(results, Date.now() - overallStart));

  const anyFailed = results.some((r) => r.status !== 'ok');
  return anyFailed ? 1 : 0;
}
