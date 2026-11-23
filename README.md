# Rocurl

Run a `curl` command through every OpenVPN (`.ovpn`) profile in a folder (in parallel or sequentially), using a single shared username and password, and get a summary of the completed work.

## Usage

Run `npx rocurl` inside a folder containing `.ovpn` files:

```bash
npx rocurl curl https://api.ipify.org
```

You can also omit the leading `curl` word:

```bash
npx rocurl -s https://ipinfo.io/json
```

When you run `rocurl`, it will:
1. Find all `.ovpn` files in the current directory (or `--dir`).
2. Prompt you once for your OpenVPN username and password (password input is hidden).
3. Request `sudo` if needed to start OpenVPN tunnels.
4. Connect up to `--concurrency` profiles at once (default: `5` on Linux/macOS, `1` on Windows):
   - In concurrent mode (`--concurrency > 1`), each tunnel runs with `--route-noexec` and an isolated per-tunnel route (Linux policy routing via `ip rule`/`ip route` table; macOS interface-scoped route via `route add -ifscope`), and each `curl` binds to its tunnel via `--interface` so parallel tunnels never conflict or hijack your host default route.
   - In sequential mode (`--concurrency 1`), each profile connects as a standard full tunnel one at a time.
5. Cleanly disconnect all tunnels, delete the temporary `0600` credentials file, and print a summary table of all results.

## Options

Rocurl options must be placed **before** the `curl` command (or before `--`):

| Option | Description |
| --- | --- |
| `--dir <path>` | Directory containing `.ovpn` files (default: current directory) |
| `--concurrency <n>` | Number of VPN profiles to run in parallel (default: `5` on Linux/macOS, `1` on Windows) |
| `--timeout <seconds>` | OpenVPN connection timeout in seconds (default: `30`) |
| `--curl-timeout <seconds>` | Maximum seconds to wait for each `curl` command |
| `--openvpn-bin <path>` | Path to the `openvpn` binary (default: auto-detected, including Homebrew `/opt/homebrew/sbin/openvpn`) |
| `--user <username>` | OpenVPN username (or set `ROCURL_USER`) |
| `--pass <password>` | OpenVPN password (or set `ROCURL_PASS`) |
| `--no-sudo` | Do not prefix `openvpn` with `sudo` |
| `--verbose` | Stream OpenVPN logs while connecting |
| `--dry-run` | List discovered `.ovpn` files and curl arguments without connecting |
| `-h, --help` | Show help text |

## Examples

```bash
# Run 5 profiles at a time (default on Linux/macOS)
npx rocurl curl -s https://api.ipify.org

# Scale up to 10 parallel VPN connections
npx rocurl --concurrency 10 curl -s https://api.ipify.org

# Run sequentially (one full-tunnel VPN at a time)
npx rocurl --concurrency 1 curl -s https://api.ipify.org

# Pass custom headers and POST data
npx rocurl -s -X POST -H "Content-Type: application/json" -d '{"ping":true}' https://httpbin.org/post

# Point to a specific folder of .ovpn files with a 45s VPN connect timeout
npx rocurl --dir ./profiles --timeout 45 curl -s https://ifconfig.me

# Preview what will run without connecting
npx rocurl --dry-run curl -s https://api.ipify.org
```

## Requirements

- Node.js >= 18
- `openvpn` installed (auto-detected on `PATH`, `/opt/homebrew/sbin/openvpn`, `/usr/local/sbin/openvpn`, `/usr/sbin/openvpn`)
- `curl` installed and on `PATH`
- Root or `sudo` access (required by OpenVPN to create TUN/TAP interfaces and configure routes)
