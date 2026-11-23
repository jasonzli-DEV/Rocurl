import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { parseArgs, runWithConcurrency, withCurlInterface } from '../src/cli.js';
import { discoverProfiles } from '../src/profiles.js';
import { getCredentials } from '../src/prompt.js';
import {
  buildOpenVpnCommand,
  connectOpenVpn,
  createAuthFile,
  extractFatalDetail,
  parseIpv4FromIpAddr,
  parseOpenVpnLogLine,
  parseUtunDevice,
  resolveOpenVpnBin,
} from '../src/openvpn.js';
import { runCurl } from '../src/curl.js';
import { formatSummary } from '../src/summary.js';

test('parseArgs strips leading curl and preserves all curl flags', () => {
  const parsed = parseArgs(['curl', '-s', '-u', 'a:b', '-v', 'https://api.ipify.org']);
  assert.equal(parsed.help, false);
  assert.deepEqual(parsed.curlArgs, ['-s', '-u', 'a:b', '-v', 'https://api.ipify.org']);
});

test('parseArgs works without leading curl word', () => {
  const parsed = parseArgs(['-s', '-X', 'POST', '-d', '{"ok":true}', 'https://example.com']);
  assert.deepEqual(parsed.curlArgs, ['-s', '-X', 'POST', '-d', '{"ok":true}', 'https://example.com']);
});

test('parseArgs parses rocurl options before curl command and -- separator', () => {
  const parsed = parseArgs([
    '--dir',
    './vpns',
    '--timeout',
    '45',
    '--curl-timeout',
    '12',
    '--no-sudo',
    '--verbose',
    '--dry-run',
    '--',
    '-s',
    'https://ipinfo.io',
  ]);
  assert.equal(parsed.dir, './vpns');
  assert.equal(parsed.timeoutSec, 45);
  assert.equal(parsed.curlTimeoutSec, 12);
  assert.equal(parsed.noSudo, true);
  assert.equal(parsed.verbose, true);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.curlArgs, ['-s', 'https://ipinfo.io']);
});

test('parseArgs validates numeric options', () => {
  assert.throws(() => parseArgs(['--timeout', 'not-a-number', 'https://example.com']), /positive number/);
  assert.throws(() => parseArgs(['--curl-timeout', '0', 'https://example.com']), /positive number/);
});

test('discoverProfiles finds and naturally sorts .ovpn files only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rocurl-test-profiles-'));
  try {
    await fs.writeFile(path.join(dir, 'us-10.ovpn'), 'client\n');
    await fs.writeFile(path.join(dir, 'us-2.ovpn'), 'client\n');
    await fs.writeFile(path.join(dir, 'de-1.OVPN'), 'client\n');
    await fs.writeFile(path.join(dir, 'readme.txt'), 'ignore\n');
    await fs.mkdir(path.join(dir, 'nested.ovpn'));

    const profiles = await discoverProfiles(dir);
    assert.deepEqual(
      profiles.map((p) => p.name),
      ['de-1.OVPN', 'us-2.ovpn', 'us-10.ovpn'],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('getCredentials reads from env vars or interactive streams', async () => {
  const fromEnv = await getCredentials({
    env: { ROCURL_USER: 'alice', ROCURL_PASS: 'secret' },
  });
  assert.deepEqual(fromEnv, { username: 'alice', password: 'secret' });

  const input = new PassThrough();
  const output = new PassThrough();
  const credsPromise = getCredentials({ env: {}, input, output });
  input.write('bob\n');
  // Wait a tick for readline to attach the second prompt
  await new Promise((r) => setTimeout(r, 10));
  input.write('hunter2\n');
  const fromPrompt = await credsPromise;
  assert.deepEqual(fromPrompt, { username: 'bob', password: 'hunter2' });
});

test('parseOpenVpnLogLine detects readiness and fatal errors', () => {
  assert.deepEqual(
    parseOpenVpnLogLine('2026-11-22 21:00:00 Initialization Sequence Completed'),
    { type: 'ready' },
  );
  assert.deepEqual(
    parseOpenVpnLogLine('AUTH: Received control message: AUTH_FAILED'),
    { type: 'error', message: 'Authentication failed (AUTH_FAILED)' },
  );
  assert.equal(parseOpenVpnLogLine('Peer Connection Initiated with [AF_INET]1.2.3.4:1194'), null);
  assert.deepEqual(parseOpenVpnLogLine('2026-11-22 22:41:26 Exiting due to fatal error'), { type: 'fatal' });
  assert.equal(
    extractFatalDetail([
      '2026-11-22 22:41:26 WARNING: Failed running command (--up/--down): could not execute external program',
      '2026-11-22 22:41:26 Exiting due to fatal error',
    ]),
    '2026-11-22 22:41:26 WARNING: Failed running command (--up/--down): could not execute external program',
  );
});

test('createAuthFile writes 0600 credentials file and cleans up completely', async () => {
  const auth = await createAuthFile('vpnuser', 'vpnpass');
  try {
    const content = await fs.readFile(auth.authFile, 'utf8');
    assert.equal(content, 'vpnuser\nvpnpass\n');
    if (process.platform !== 'win32') {
      const stat = await fs.stat(auth.authFile);
      assert.equal(stat.mode & 0o777, 0o600);
    }
  } finally {
    await auth.cleanup();
  }
  await assert.rejects(() => fs.stat(auth.tempDir));
});

test('buildOpenVpnCommand puts --config before --auth-user-pass and wraps sudo when requested', () => {
  const cmd = buildOpenVpnCommand({
    profilePath: '/tmp/vpns/us.ovpn',
    authFile: '/tmp/rocurl/auth.txt',
    pidFile: '/tmp/rocurl/ovpn.pid',
    useSudo: true,
  });
  assert.equal(cmd.command, 'sudo');
  assert.equal(cmd.args[0], 'openvpn');
  assert.ok(cmd.args.indexOf('--config') < cmd.args.indexOf('--auth-user-pass'));
});

test('connectOpenVpn connects and cleanly disconnects with a mock openvpn binary', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rocurl-mock-ovpn-'));
  const auth = await createAuthFile('u', 'p');
  try {
    const mockBin = path.join(tmpDir, 'mock-openvpn.mjs');
    await fs.writeFile(
      mockBin,
      `#!/usr/bin/env node
import fs from 'node:fs';
const pidIdx = process.argv.indexOf('--writepid');
if (pidIdx !== -1 && process.argv[pidIdx + 1]) {
  fs.writeFileSync(process.argv[pidIdx + 1], String(process.pid));
}
console.log('Connecting...');
setTimeout(() => {
  console.log('Initialization Sequence Completed');
}, 30);
process.on('SIGTERM', () => {
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );

    const profilePath = path.join(tmpDir, 'test.ovpn');
    await fs.writeFile(profilePath, 'client\n');

    const vpn = await connectOpenVpn({
      profilePath,
      authFile: auth.authFile,
      tempDir: auth.tempDir,
      useSudo: false,
      timeoutMs: 5000,
      openvpnBin: mockBin,
    });

    assert.ok(vpn.connectDurationMs >= 0);
    await vpn.disconnect();
  } finally {
    await auth.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('connectOpenVpn rejects immediately on AUTH_FAILED', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rocurl-mock-fail-'));
  const auth = await createAuthFile('u', 'bad');
  try {
    const mockBin = path.join(tmpDir, 'mock-openvpn-fail.mjs');
    await fs.writeFile(
      mockBin,
      `#!/usr/bin/env node
console.log('AUTH: Received control message: AUTH_FAILED');
process.exit(1);
`,
      { mode: 0o755 },
    );

    const profilePath = path.join(tmpDir, 'bad.ovpn');
    await fs.writeFile(profilePath, 'client\n');

    await assert.rejects(
      () =>
        connectOpenVpn({
          profilePath,
          authFile: auth.authFile,
          tempDir: auth.tempDir,
          useSudo: false,
          timeoutMs: 5000,
          openvpnBin: mockBin,
        }),
      /Authentication failed/,
    );
  } finally {
    await auth.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runCurl executes command and captures stdout and exit code', async () => {
  const res = await runCurl(['--version']);
  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.match(res.stdout, /curl/i);
});

test('formatSummary renders counts and aligned rows', () => {
  const summary = formatSummary(
    [
      {
        profile: 'us-east.ovpn',
        status: 'ok',
        connectDurationMs: 2100,
        curlDurationMs: 350,
        curlExitCode: 0,
        stdout: '203.0.113.10\n',
      },
      {
        profile: 'eu-west.ovpn',
        status: 'vpn_error',
        error: 'Authentication failed (AUTH_FAILED)',
      },
      {
        profile: 'jp-tokyo.ovpn',
        status: 'curl_error',
        connectDurationMs: 1800,
        curlDurationMs: 500,
        curlExitCode: 7,
        stderr: 'Failed to connect',
      },
    ],
    4750,
  );

  assert.match(summary, /Completed: 3 profiles \| Succeeded: 1 \| Failed: 2 \(VPN: 1, Curl: 1\)/);
  assert.match(summary, /us-east\.ovpn\s+OK\s+2\.1s\s+350ms\s+203\.0\.113\.10/);
  assert.match(summary, /eu-west\.ovpn\s+VPN ERR/);
  assert.match(summary, /jp-tokyo\.ovpn\s+CURL\(7\)/);
});

test('parseArgs parses --concurrency and --openvpn-bin and validates --concurrency', () => {
  const parsed = parseArgs([
    '--concurrency',
    '8',
    '--openvpn-bin',
    '/opt/homebrew/sbin/openvpn',
    'curl',
    '-s',
    'https://api.ipify.org',
  ]);
  assert.equal(parsed.concurrency, 8);
  assert.equal(parsed.openvpnBin, '/opt/homebrew/sbin/openvpn');
  assert.deepEqual(parsed.curlArgs, ['-s', 'https://api.ipify.org']);

  assert.throws(() => parseArgs(['--concurrency', '0', 'https://example.com']), /positive integer/);
  assert.throws(() => parseArgs(['--concurrency', '2.5', 'https://example.com']), /positive integer/);
});

test('buildOpenVpnCommand adds isolated routing flags for Linux and macOS', () => {
  const linuxCmd = buildOpenVpnCommand({
    profilePath: '/tmp/vpns/us.ovpn',
    authFile: '/tmp/rocurl/auth.txt',
    pidFile: '/tmp/rocurl/ovpn.pid',
    useSudo: true,
    isolated: true,
    slot: 3,
    platform: 'linux',
  });
  assert.equal(linuxCmd.devName, 'rocurl3');
  assert.ok(linuxCmd.args.includes('--route-noexec'));
  assert.ok(linuxCmd.args.includes('rocurl3'));
  assert.ok(linuxCmd.args.includes('--dev-type'));

  const macCmd = buildOpenVpnCommand({
    profilePath: '/tmp/vpns/us.ovpn',
    authFile: '/tmp/rocurl/auth.txt',
    pidFile: '/tmp/rocurl/ovpn.pid',
    useSudo: true,
    isolated: true,
    slot: 2,
    platform: 'darwin',
  });
  assert.equal(macCmd.devName, null);
  assert.ok(macCmd.args.includes('--route-noexec'));
  assert.ok(macCmd.args.includes('tun'));
});

test('parseUtunDevice, parseIpv4FromIpAddr, resolveOpenVpnBin, and withCurlInterface', () => {
  assert.equal(parseUtunDevice('2026-11-22 22:00:00 Opened utun device utun7'), 'utun7');
  assert.equal(parseUtunDevice('unrelated log line'), null);

  assert.equal(
    parseIpv4FromIpAddr('12: rocurl0    inet 10.2.0.2/16 scope global rocurl0\\       valid_lft forever'),
    '10.2.0.2',
  );
  assert.equal(parseIpv4FromIpAddr(''), null);

  assert.equal(resolveOpenVpnBin('/custom/openvpn'), '/custom/openvpn');
  assert.ok(resolveOpenVpnBin().includes('openvpn'));

  assert.deepEqual(withCurlInterface(['-s', 'https://api.ipify.org'], '10.2.0.2'), [
    '--interface',
    '10.2.0.2',
    '-s',
    'https://api.ipify.org',
  ]);
  assert.deepEqual(withCurlInterface(['--interface', 'eth0', 'https://api.ipify.org'], '10.2.0.2'), [
    '--interface',
    'eth0',
    'https://api.ipify.org',
  ]);
});

test('runWithConcurrency executes in parallel with bounded slots and preserves order', async () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  let active = 0;
  let maxActive = 0;
  const usedSlots = new Set();

  const results = await runWithConcurrency(items, 3, async (item, index, slot) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    usedSlots.add(slot);
    await new Promise((r) => setTimeout(r, 25));
    active -= 1;
    return `${index}:${item}`;
  });

  assert.deepEqual(results, ['0:a', '1:b', '2:c', '3:d', '4:e', '5:f']);
  assert.equal(maxActive, 3);
  assert.deepEqual([...usedSlots].sort(), [0, 1, 2]);
});
