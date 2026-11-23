# Rocurl

Run a `curl` command sequentially through every OpenVPN (`.ovpn`) profile in a folder, using a single shared username and password, and get a summary of the completed work.

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
4. For each `.ovpn` profile:
   - Connect to OpenVPN using a temporary `0600` credentials file.
   - Wait for `Initialization Sequence Completed`.
   - Execute your `curl` command through the tunnel.
   - Cleanly disconnect OpenVPN before moving to the next profile.
5. Delete the temporary credentials file and print a summary table of all results.

## Options

Rocurl options must be placed **before** the `curl` command (or before `--`):

| Option | Description |
| --- | --- |
| `--dir <path>` | Directory containing `.ovpn` files (default: current directory) |
| `--timeout <seconds>` | OpenVPN connection timeout in seconds (default: `30`) |
| `--curl-timeout <seconds>` | Maximum seconds to wait for each `curl` command |
| `--user <username>` | OpenVPN username (or set `ROCURL_USER`) |
| `--pass <password>` | OpenVPN password (or set `ROCURL_PASS`) |
| `--no-sudo` | Do not prefix `openvpn` with `sudo` |
| `--verbose` | Stream OpenVPN logs while connecting |
| `--dry-run` | List discovered `.ovpn` files and curl arguments without connecting |
| `-h, --help` | Show help text |

## Examples

```bash
# Simple GET request across all profiles in the current directory
npx rocurl curl -s https://api.ipify.org

# Pass custom headers and POST data
npx rocurl -s -X POST -H "Content-Type: application/json" -d '{"ping":true}' https://httpbin.org/post

# Point to a specific folder of .ovpn files with a 45s VPN connect timeout
npx rocurl --dir ./profiles --timeout 45 curl -s https://ifconfig.me

# Preview what will run without connecting
npx rocurl --dry-run curl -s https://api.ipify.org
```

## Requirements

- Node.js >= 18
- `openvpn` installed and on `PATH`
- `curl` installed and on `PATH`
- Root or `sudo` access (required by OpenVPN to create TUN/TAP interfaces and update routes)
