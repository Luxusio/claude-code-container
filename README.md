# Claude Code Container (ccc)

Single command. Isolated environment. No setup required.

## Features

- Per-project isolated containers
- Runs on **Docker or Podman** — auto-detect, Podman preferred when both are installed
- Host env vars, SSH keys, locale, timezone auto-forwarded
- Auto-cleanup on session exit
- [mise](https://mise.jdx.dev/) tool version management (auto-detect `mise.toml`)
- Built-in Chromium for headless testing
- Auto-pull container image on first run

## Installation

### From npm (end users)

```bash
npm install -g claude-code-container
```

The postinstall hook builds the desktop UI binary automatically. Timing:

- First install: ~3 min (requires `cargo` and, on Linux, `libwebkit2gtk-4.1`)
- Incremental rebuilds: ~30 sec (cargo incremental compilation)
- If the UI build fails (e.g. missing cargo), the CLI still installs successfully and prints a warning with manual recovery steps
- The UI uses a debug binary to keep install time reasonable

### From source (developers)

```bash
git clone <repo>
cd claude-code-container
npm install
npm run install:global          # prompts for sudo when writing /usr/local/bin
```

Do NOT use `sudo npm run install:global` — cargo/rustup refuse to run under sudo. The install
script invokes sudo internally only for the `/usr/local/bin` writes. To uninstall: `npm run uninstall:global`.

For development setup, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick Start

```bash
ccc                        # Run Claude in current project
ccc --continue             # Continue previous session
ccc shell                  # Open bash shell
ccc npm test               # Run arbitrary command
```

## Commands

```bash
ccc                        # Run Claude
ccc shell                  # Open bash shell
ccc <command>              # Run command in container
ccc stop                   # Stop container
ccc rm                     # Remove container
ccc status                 # Show all containers
ccc doctor                 # Health check
ccc labs                   # Show lab-runner container VM readiness
ccc labs smoke             # Non-starting lab-runner VM smoke check
ccc labs shell             # Open bash in the built-in lab-runner profile
ccc clean                  # Clean stopped containers/images
ccc runtime                # Print detected container runtime + flavor
ccc ui                     # Launch the desktop app (Tauri 2). Set CCC_DEV=1 for live reload.
```

## Container VM Labs

CCC configures ordinary project containers and the built-in `lab-runner`
profile with the same lazy `device-lab` Linux VM contract. On supported native Linux
hosts, containers receive a durable owner-scoped lab state volume plus bounded
`/dev/kvm` access for in-container QEMU. On unsupported hosts, CCC still mounts
the lab state volume and injects clear unsupported diagnostics, without using
`--privileged`, host TUN devices, or manual environment variables.
Both `Dockerfile` and `Containerfile` include the QEMU/KVM userland packages
needed by this optional path, so Docker and Podman image builds keep the same
zero-configuration VM capability contract.

`ccc labs` and `ccc labs smoke` inspect this contract without starting a VM.
The smoke output reports the default project container and the built-in
`lab-runner` profile separately, so agents can tell whether ordinary in-container
`device-lab` `linux-vm` work is available or should remain SKIP on the current host.

## Real Device Lab Tests

Real host-provider tests are split by authority level:

```bash
npm run test:level1       # Readiness/inventory only
npm run test:level2       # Creates disposable VMs, simulators, emulators, or sandboxes when prerequisites exist
npm run test:level3       # Runs Level 3 and writes a platform result, or aggregates result files passed after --
npm run test:level3:hyper-v          # Runs only the Hyper-V Windows and Linux VM E2E tests
npm run test:level3:hyper-v:windows  # Runs only the Hyper-V Windows VM E2E test
npm run test:level3:hyper-v:linux    # Runs only the Hyper-V Linux VM E2E test
```

The targeted Hyper-V commands rebuild the packaged test artifacts and prepare
the host broker automatically before running the selected provider tests.

Run `npm run test:level3` on each provider host. Selecting Level 3 is the
explicit authorization for destructive operations against disposable or leased
test devices. The command runs as a Vitest integration test and writes
`results/device-lab-level3-<platform>.json`; host-specific provider skips remain
in the result because no single host can provide macOS/iOS, Windows Sandbox, and
Linux KVM simultaneously. Collect the results and run the same command with the
files after `--`:

```bash
npm run test:level3 -- results/device-lab-level3-linux.json results/device-lab-level3-darwin.json results/device-lab-level3-win32.json
```

The matrix succeeds only when the result union verifies every public tool with a
direct successful source and packaged-MCP call, every Android/iOS/macOS/Windows
provider through its dedicated real E2E file, physical wireless status, and a
real Linux VM boot. Broker diagnostic calls do not count as provider evidence.

Level 3 writes platform results. To inspect a result manually:

```bash
node scripts/test-level.js --summarize-json results/device-lab-level3-darwin.json
node scripts/test-level.js --assert-json results/device-lab-level3-darwin.json --platform-result
```

The JSON artifact records total/pass/skip/fail counts, every test step, and
MCP tool coverage (`scriptedPublicTools`, `calledPublicTools`,
`calledHiddenCompatibilityTools`, `uncalledScriptedTools`, and
`unscriptedAdvertisedTools`) plus argument facets such as
`device_broker_appium:action=start`, per-call outcomes, unexpected MCP
`error-result` records, and skip categories. The summary separates missing
provider prerequisites (`provider-prerequisite`), incompatible host platforms
(`host-platform`), missing virtualization (`host-virtualization`), unproven
tool surfaces, unproven action variants, and incomplete MCP call results
without requiring anyone to scan long terminal logs.

On a container or host without Android SDK/ADB, Xcode/iOS, Windows Sandbox,
macOS VM, KVM, or leased hardware prerequisites, a platform result records
categorized skips while still requiring zero coverage and outcome failures.
The final matrix, rather than an impossible single-host zero-skip run, rejects
any provider evidence still missing across the collected hosts.
`--assert-json` exits non-zero for real test failures, tool coverage gaps,
incomplete or unexpected MCP call outcomes, or
skip categories outside `provider-prerequisite`, `host-platform`, and
`host-virtualization`. Override those allowed categories with
`CCC_REAL_DEVICE_LAB_ALLOWED_SKIP_CATEGORIES` when a stricter CI lane requires
`skip=0`.
Inside a CCC project container, `ccc devices broker status`,
`ccc devices backends`, and `ccc devices smoke` also validate the device-lab
container wiring. If the container was created by an older CCC build, these
commands report whether `/home/ccc/.ccc/devices` is missing, then print the
recovery action: restart CCC from the host so the project container is recreated
with the shared device state mount. Owner identity is resolved through the host
broker instead of injected into the container as an environment variable. This
diagnostic is non-starting; it does not create emulators, simulators,
sandboxes, VMs, Appium sessions, or provider processes. `ccc devices smoke`
also runs an installed MCP surface check named `device-lab-mcp-installed`;
if the configured bundled MCP server is missing or the image falls back to a
stale `/opt/ccc/device-lab-mcp/server.mjs`, this check fails with the
advertised-tool/handler mismatch instead of leaving agents to discover
`Unknown tool` later.

Host-backed device definitions can be controlled through the public CCC CLI.
For example, Windows Sandbox creation and startup default to minimized mode:

```text
ccc devices create windows-sandbox dev-sandbox
ccc devices start dev-sandbox
ccc devices status dev-sandbox
ccc devices stop dev-sandbox
ccc devices delete dev-sandbox
```

Create, start, stop, delete, and device-specific status use the authenticated
owner-scoped host broker. Lifecycle calls for the same device are serialized
across CLI and MCP processes.

Use `ccc devices start dev-sandbox --no-minimized` only when a visible Sandbox
window is intentional. The device status reports broker-owned state and the
last successful minimize confirmation; it does not claim to be a continuous
desktop-window monitor. These commands automatically start or reuse the host
broker and do not require direct execution of files under `dist/`.

Hyper-V Windows VMs use the same lifecycle surface. CCC automatically downloads,
validates, and caches the official Windows Server 2025 evaluation VHDX on the
first `windows-vm` create, then creates owner-scoped differencing disks:

```text
ccc devices setup hyper-v
ccc devices setup hyper-v --confirm --accept-windows-evaluation-license
ccc devices backends
ccc devices create windows-vm dev-windows --memory-mb 4096 --cpus 2
# Later VMs reuse the verified windows-server cache.
ccc devices create windows-vm dev-windows-2 --memory-mb 4096 --cpus 2
ccc devices start dev-windows
ccc devices status dev-windows
ccc devices reboot dev-windows --wait-for-boot --boot-timeout-ms 600000
ccc devices stop dev-windows
ccc devices snapshot create dev-windows before-install
ccc devices snapshot restore dev-windows before-install --confirm-destructive
ccc devices snapshot delete dev-windows before-install --confirm-destructive
ccc devices delete dev-windows
```

The first setup command is diagnostic only. `--confirm` explicitly permits CCC
to request UAC elevation, enable `Microsoft-Hyper-V-All` with `-NoRestart`, and
add the invoking identity to the built-in `Hyper-V Administrators` group.
`--accept-windows-evaluation-license` records the required one-time acceptance
of the linked Microsoft evaluation terms and the explicit HTTPS/TOFU trust
decision for the allowlisted Microsoft download chain. Microsoft does not
publish a stable digest for that mutable evaluation redirect, so CCC reports
the mode as TOFU, records the first acquired SHA-256, and rejects later cache
changes; it records neither acceptance nor trust silently.
CCC reports whether a reboot or one-time sign-out and sign-in is required to
activate the new group membership; it never reboots or signs out the host itself.

`ccc devices backends` reports whether the required host executables are
discoverable. Use `ccc devices setup hyper-v` for the non-mutating Hyper-V
feature/module/hypervisor/VMMS diagnostic, then use
`ccc devices smoke --real-provider --timeout-ms 30000` for provider readiness;
neither command starts a VM. VM lifecycle commands
verify the owner marker, VM ID, VM name, and disk path before mutation. Image
source paths are restricted to regular VHDX files directly under the project root. Imported
images are hashed, validated with `Get-VHD`, and stored with a versioned
manifest below the host-only `~/.ccc/device-broker-private/images/hyper-v/<profile>`;
links, differencing
parents, profile hash conflicts, cache hash mismatches, and paths outside the allowed roots are refused.
Production checkpoint create/restore/delete uses the same owner-fenced broker
path. Guest command execution and file transfer use an owner-fenced PowerShell
Direct session and a broker-owned DPAPI credential file. CCC injects the
per-device account into the offline child disk, removes bootstrap secrets after
first logon, and waits for PowerShell Direct before reporting a ready start;
credentials are never accepted as MCP arguments. A project-local generalized
Windows 11 VHDX remains available as an explicit `--source-image` override.
Writable VM disks, Linux seed disks, credentials, transfer staging, operation
journals, and CCC-owned NAT allocations also stay in the host-only broker tree,
which is not mounted into project containers. CCC-owned NAT networking is
shared with Hyper-V Linux guests. MAC and IPv4 assignments are deterministic
per owner/device and allocation cleanup is fenced by the VM incarnation.
Overlapping host subnets are rejected; an existing NAT is reused or removed
only when broker-private state proves CCC created it. The CCC switch, NAT, and
gateway are removed after the last allocation. Repeating create with
the same immutable VM configuration returns the existing owner-fenced VM;
conflicting create requests remain errors. Start, stop, and delete are safe to
repeat, and none of these retries adopts an unmarked Hyper-V resource.

Hyper-V Linux VMs automatically download a dated official Ubuntu 24.04 LTS Azure
VHD archive, verify it against CCC's pinned release SHA-256, convert it to VHDX,
and cache it on first create. Later creates reuse it. CCC
creates an owner-scoped SSH key and CIDATA cloud-init disk, assigns a static
address on the CCC NAT, and uses SSH for execution and bounded downloads plus
SCP for bounded uploads:

```text
ccc devices create linux-vm dev-ubuntu --memory-mb 2048 --cpus 2
ccc devices start dev-ubuntu --wait-for-boot --boot-timeout-ms 600000
ccc devices reboot dev-ubuntu --wait-for-boot --boot-timeout-ms 600000
ccc devices snapshot create dev-ubuntu baseline
```

Run destructive Hyper-V durability directly; a first-run cache miss is acquired automatically:

```text
npm run test:durability:device-lab:real -- --target windows-vm --cycles 2
npm run test:durability:device-lab:real -- --target linux-vm --cycles 2
```

The regular Level 3 Windows VM scenario also packs the current CCC candidate,
uploads it with the current Windows `node.exe`, runs `ccc --version` inside the
disposable guest, and downloads the result to
`results/device-lab-real/hyper-v-windows-packaged-ccc-latest.json`. Durability
cycles omit that large package transfer and focus on repeated provider cleanup.

To verify the actual installed MCP server used by a running container image,
run the installed-server smoke directly:

```bash
node scripts/real-tests/installed-mcp-smoke.ts /opt/ccc/dist/device-lab-mcp/server.mjs
```

This catches stale image installs where `tools/list` advertises a public tool
such as `device_status`, but `tools/call` still returns `Unknown tool` or the
current-display device aliases are missing. Use
`CCC_REAL_DEVICE_LAB_MCP_SERVER=<server.mjs>` to point the same check at a
different installed server path.

On macOS, Level 2 now includes real iOS Simulator and Tart-backed macOS VM E2E
coverage when the host has the required tools. iOS Simulator tests require a
full active Xcode install with `xcrun simctl` available. Physical iOS smoke
coverage requires `xcrun xctrace`. Exactly one visible physical iOS device is
selected automatically; when multiple devices are visible,
`CCC_REAL_IOS_DEVICE_UDID=<udid>` selects the leased test device explicitly.
Deeper Appium/XCUITest automation still reports its own
`xcodebuild`/driver prerequisites separately. macOS VM E2E tests require Tart
(`brew install cirruslabs/cli/tart`). A stopped local image explicitly named as
a macOS base/template, such as `ccc-macos-base`, is preferred automatically as
a read-only clone source; unrelated user VMs and registry entries are not
mutated. If multiple equally preferred local candidates exist, the E2E skips
and reports their names instead of guessing. Set
`CCC_REAL_MACOS_VM_SOURCE_IMAGE=<image-or-vm>` to choose explicitly; the older
`CCC_REAL_TART_SOURCE_IMAGE` name is still accepted. The macOS VM E2E always
prepares SSH helper metadata using a default short user derived from the
project name, falling back to `ccc`, and an owner-scoped ed25519 key under
`~/.ccc/devices/real-tests/macos-vm-ssh/`. The corresponding `.pub` key must
already be trusted by the guest image account before guest `exec`, screenshot,
upload/download, and window-list helper coverage can run. The E2E discovers
the guest IP automatically with Tart; set `CCC_REAL_MACOS_VM_SSH_HOST=<host-or-ip>`
only to override discovery. If Tart cannot report an IP within the bounded
wait, the VM lifecycle still passes and guest helper coverage is reported as
skipped. Optional `CCC_REAL_MACOS_VM_SSH_USER`,
`CCC_REAL_MACOS_VM_SSH_PORT`, and `CCC_REAL_MACOS_VM_SSH_KEY_PATH` values
override the defaults. Compatibility names `CCC_REAL_TART_SSH_USER`,
`CCC_REAL_TART_SSH_HOST`, `CCC_REAL_TART_SSH_PORT`, and
`CCC_REAL_TART_SSH_KEY_PATH` are also accepted. When Tart exposes
`--with-softnet`, the backend uses it automatically for VM starts. The Tart
backend first tries the default DHCP lease resolver, then falls back to
`tart ip --resolver=arp`, and records recent IP lookup attempts in the boot
result when discovery still fails. IP discovery waits up to 10 seconds by
default; override that with `CCC_REAL_MACOS_VM_BOOT_TIMEOUT_MS` when the source
image is slower. Backend
provider operations are also bounded and can be tuned with
`CCC_MACOS_VM_CLONE_TIMEOUT_MS`, `CCC_MACOS_VM_STOP_TIMEOUT_MS`,
`CCC_MACOS_VM_DELETE_TIMEOUT_MS`, and `CCC_MACOS_VM_IP_TIMEOUT_MS`. macOS VM
guest SSH/SCP helper operations default to 30 seconds and can be tuned per call
with `helperTimeoutMs` or globally with `CCC_MACOS_VM_HELPER_TIMEOUT_MS`; the
real E2E wrapper also accepts `CCC_REAL_MACOS_VM_HELPER_TIMEOUT_MS`.

Level 3 runs destructive checks by definition. Use it only with disposable VM
images, owned emulators, or leased physical devices. Android emulator app
install/launch/reset/uninstall coverage
is enabled when `CCC_REAL_ANDROID_APK=<path-to-disposable.apk>` and
`CCC_REAL_ANDROID_PACKAGE=<package.name>` are both set; compatibility names
`CCC_REAL_DEVICE_LAB_ANDROID_APK` and `CCC_REAL_DEVICE_LAB_ANDROID_PACKAGE` are
also accepted. iOS Simulator app install/launch/reset/uninstall coverage is
enabled when `CCC_REAL_IOS_SIMULATOR_APP=<path-to-disposable.app>` and
`CCC_REAL_IOS_SIMULATOR_BUNDLE_ID=<bundle.id>` are both set; compatibility
names `CCC_REAL_DEVICE_LAB_IOS_SIMULATOR_APP` and
`CCC_REAL_DEVICE_LAB_IOS_SIMULATOR_BUNDLE_ID` are also accepted. Without those
values, the Android emulator and iOS Simulator E2Es still run the safe
device/mobile controls and report app-artifact coverage as skipped. For full
app-specific Level 3 coverage, Android also requires
`CCC_REAL_ANDROID_PERMISSION` for emulator grant/revoke coverage. For physical
Android coverage, set `CCC_REAL_ANDROID_DEVICE_SERIAL` plus
`CCC_REAL_ANDROID_DEVICE_APK`, `CCC_REAL_ANDROID_DEVICE_PACKAGE`, and
`CCC_REAL_ANDROID_DEVICE_PERMISSION` so attach, ADB shell/UI/screenshot,
upload/download, app lifecycle, and permission paths all run. iOS Simulator
requires Appium/XCUITest prerequisites for touch/gesture controls.
iOS physical-device coverage additionally uses `CCC_REAL_IOS_DEVICE_UDID`,
Appium/XCUITest prerequisites, and `CCC_REAL_IOS_DEVICE_BUNDLE_ID`; set
`CCC_REAL_IOS_DEVICE_APP=<path-to-disposable.app>` when install coverage should
run before launch/wait/stop.

## Container Runtime (Docker or Podman)

`ccc` works with either Docker or Podman. At startup it detects which
runtime is available and picks it automatically.

```bash
ccc runtime                # e.g. runtime=podman version=5.2.3 flavor=podman-rootless socket=...
```

**Selection order (first hit wins):**

1. `--runtime <docker|podman>` CLI flag
2. `CCC_RUNTIME=docker|podman` environment variable
3. `podman` on PATH → Podman
4. `docker` on PATH → Docker

**Podman specifics handled automatically:**

- **Rootless Podman on Linux**: `--userns=keep-id` is added so host UID maps
  to the container `ccc` user. No manual UID remapping needed.
- **SELinux**: bind mounts get the `:Z` relabel suffix when SELinux is
  enforcing. Gate via `CCC_SELINUX_RELABEL=auto|force|off` (default `auto`).
- **podman machine (macOS/Windows)**: treated like Docker Desktop —
  `host.docker.internal` rewriting and the localhost proxy both apply.
- **Podman socket**: `$XDG_RUNTIME_DIR/podman/podman.sock` (rootless) or
  `/run/podman/podman.sock` (rootful) is substituted for `/var/run/docker.sock`
  on the host side; containers still see `/var/run/docker.sock`. Start it
  with `systemctl --user start podman.socket` if tools inside the container
  need to talk to the runtime. Override the path with
  `CCC_RUNTIME_SOCKET=/custom/socket` when needed.

If neither runtime is installed, `ccc` exits with a clear error.

## Profiles

Switch between different Claude accounts or credential sets. Each profile gets its own `~/.claude` directory and container, fully isolated.

```bash
ccc profile add work       # Create profile
ccc profile list           # List profiles
ccc profile rm work        # Remove profile

CCC_PROFILE=work ccc       # Run with profile
```

Profiles are for **credential directory isolation** only. For environment variables (API keys, backend URLs), use [mise environments](doc/mise-environments.md):

```toml
# mise.toml
[env]
ANTHROPIC_BASE_URL = "http://host.docker.internal:11434/v1"
ANTHROPIC_API_KEY = "dummy"
```

## Worktree Workspaces

```bash
ccc @feature               # Create workspace + run Claude
ccc @feature --continue    # Continue in workspace
ccc @                      # List workspaces
ccc @feature rm            # Remove workspace
```

Each workspace has its own container and can run simultaneously.

## SSH

SSH keys and agent are auto-mounted from host. No setup required.

Every local container invocation mounts the registered credential directories
for all supported coding tools (Claude, Codex, Gemini, and OpenCode), regardless
of which tool or shell command starts the container.

```bash
# If SSH isn't working:
ssh-add ~/.ssh/id_ed25519   # Add key to agent
ccc rm && ccc               # Recreate container
```

## Environment Variables

Host env vars are auto-forwarded (except system vars like `PATH`, `HOME`).

For per-project env configuration (API keys, LLM backends), see [mise environments guide](doc/mise-environments.md).

For running a local LLM (llama.cpp) with ccc, see [local LLM guide](doc/llamacpp.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture, development setup, and release process.

## License

MIT
