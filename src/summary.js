/**
 * Format milliseconds into a human-readable seconds string (e.g., "1.4s").
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Truncate a single-line preview of text to maxLen characters.
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string}
 */
export function formatPreview(text, maxLen = 60) {
  const cleaned = String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '(empty)';
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

/**
 * Render an aligned plain-text summary table for all profile runs.
 *
 * @param {Array<{
 *   profile: string,
 *   status: 'ok' | 'vpn_error' | 'curl_error' | 'skipped',
 *   connectDurationMs?: number | null,
 *   curlDurationMs?: number | null,
 *   curlExitCode?: number | null,
 *   stdout?: string,
 *   stderr?: string,
 *   error?: string
 * }>} results
 * @param {number} totalDurationMs
 * @returns {string}
 */
export function formatSummary(results, totalDurationMs) {
  const total = results.length;
  const succeeded = results.filter((r) => r.status === 'ok').length;
  const vpnErrors = results.filter((r) => r.status === 'vpn_error').length;
  const curlErrors = results.filter((r) => r.status === 'curl_error').length;
  const failed = total - succeeded;

  const rows = results.map((r) => {
    const statusLabel =
      r.status === 'ok'
        ? 'OK'
        : r.status === 'vpn_error'
          ? 'VPN ERR'
          : r.status === 'curl_error'
            ? `CURL(${r.curlExitCode ?? '?'})`
            : 'SKIPPED';

    const detail =
      r.status === 'ok'
        ? formatPreview(r.stdout)
        : formatPreview(r.error || r.stderr || r.stdout || 'Unknown error');

    return {
      profile: r.profile,
      status: statusLabel,
      vpn: formatDuration(r.connectDurationMs),
      curl: formatDuration(r.curlDurationMs),
      detail,
    };
  });

  const headers = {
    profile: 'Profile',
    status: 'Status',
    vpn: 'VPN',
    curl: 'Curl',
    detail: 'Output / Error',
  };

  const widths = {
    profile: Math.max(headers.profile.length, ...rows.map((r) => r.profile.length)),
    status: Math.max(headers.status.length, ...rows.map((r) => r.status.length)),
    vpn: Math.max(headers.vpn.length, ...rows.map((r) => r.vpn.length)),
    curl: Math.max(headers.curl.length, ...rows.map((r) => r.curl.length)),
  };

  const formatRow = (r) =>
    `${r.profile.padEnd(widths.profile)}  ${r.status.padEnd(widths.status)}  ${r.vpn.padStart(widths.vpn)}  ${r.curl.padStart(widths.curl)}  ${r.detail}`;

  const divider = '-'.repeat(
    widths.profile + widths.status + widths.vpn + widths.curl + headers.detail.length + 12,
  );

  const lines = [
    '',
    '=== Rocurl Summary ===',
    `Completed: ${total} profile${total === 1 ? '' : 's'} | Succeeded: ${succeeded} | Failed: ${failed} (VPN: ${vpnErrors}, Curl: ${curlErrors}) | Total time: ${formatDuration(totalDurationMs)}`,
    '',
    formatRow(headers),
    divider,
    ...rows.map(formatRow),
    '',
  ];

  return lines.join('\n');
}
