---
type: AUDIT
status: current
source: PLAN__device-lab-mcp.md
created: 2026-06-18
---

# Device Lab Plan Completion Audit

This audit records the current completion state for
`doc/common/PLAN__device-lab-mcp.md`. It is intentionally evidence-based:
requirements are classified from the current plan, source tree, tests, and
harness handoffs rather than from conversation memory.

## Status Legend

- `implemented`: Source and tests/docs show the requirement is implemented.
- `explicit-deferred`: The plan intentionally leaves the item as future,
  provider-specific, manual, or out of scope.
- `remaining`: The plan still names this as implementation work.
- `needs-verification`: Source appears present, but the audit did not yet prove
  the full requirement with a matching verification path.

## Implemented Requirement Groups

| Area | Status | Evidence |
| --- | --- | --- |
| Source layout and small MCP entrypoint | implemented | `device-lab-mcp/src/{server,tools,context,responses,commands}.mjs`, backend modules under `device-lab-mcp/src/backends/`, state modules under `device-lab-mcp/src/state/`, and package tests in `src/__tests__/package.test.ts`. |
| Current display/X11 integration | implemented | `device-lab-mcp/src/display/x11.mjs`, `display_*` tool schemas in `device-lab-mcp/src/tools.mjs`, MCP forwarding tests showing standalone X11 retirement, and `TASK__retire-standalone-x11-display-mcp`. |
| Owner identity and per-container isolation | implemented | `src/device-lab-owner.ts`, broker-resolved owner identity, owner-basis env removal in `src/docker.ts`, owner context tests, profile/worktree tests, physical lease store tests, and broker attach tests. |
| Host broker foundation, auth, service manager, cleanup, routing | implemented | `src/device-lab-broker.ts`, `device-lab-mcp/src/broker.mjs`, broker tools in `tools.mjs`, broker/status/service/command/appium/route tests, and handoffs for broker auth/routing/cleanup. |
| Common lifecycle tools | implemented | `device_create`, `device_attach`, `device_detach`, `device_start`, `device_stop`, `device_delete`, `device_status`, `device_inventory`, and `device_list` schemas plus backend handlers and backend-specific test suites. |
| Android emulator foundation, direct ADB controls, and provider routing hardening | implemented | `device-lab-mcp/src/backends/android.mjs`, Android emulator tests, direct UIAutomator dump, ADB primitive controls, file/app primitives, video recording, mobile action tests, and explicit backend-hint collision/mismatch coverage. |
| Physical Android attach, Wi-Fi attach, leases, controls, and provider routing hardening | implemented | `device-lab-mcp/src/backends/android-device.mjs`, physical lease store, broker attach, wireless bootstrap, Android real-device tests, direct-provider lease heartbeat/cleanup behavior, and explicit backend-hint collision/mismatch coverage. |
| iOS Simulator lifecycle, simctl actions, Appium/XCUITest, recording, files | implemented | `device-lab-mcp/src/backends/ios-simulator.mjs`, fake iOS MCP fixture, iOS simulator tests, Appium/XCUITest tests, and broker-routed iOS simulator recording tests. |
| Physical iOS attach, leases, Apple readiness diagnostics, Appium/XCUITest | implemented | `device-lab-mcp/src/backends/ios-device.mjs`, broker Apple diagnostics, iOS real-device tests, fake Xcode/Appium coverage, and manual-required trust/pairing diagnostics. |
| Windows Sandbox lifecycle, helper file channel, GUI controls, accessibility, recording, file transfer | implemented | `device-lab-mcp/src/backends/windows-sandbox.mjs`, Windows backend tests, guest helper foundation/control/file-channel/accessibility/video handoffs, and helper guest-path validation before upload/download requests. |
| macOS VM definitions, provider discovery, Tart image/clone/snapshot, SSH helper bridge, GUI/accessibility/video/file operations | implemented | `device-lab-mcp/src/backends/macos-vm.mjs`, macOS VM tests, macOS desktop/video tests, fake `tart`/`ssh`/`scp` fixtures, SCP-safe guest-path validation, and macOS handoff artifacts. |
| Stale container device-lab wiring diagnostics | implemented | `src/docker.ts` recreates existing project containers when the host-backed device-state mount is missing; `CCC_DEVICE_LAB_OWNER_BASIS` is no longer injected or required for this contract. `ccc devices broker status`, `ccc devices backends`, `ccc devices smoke`, MCP `device_broker_status`, and MCP `device_backends` report the container contract, warning, and host-restart remedy without starting provider resources. |
| Mobile Appium dependencies and high-level mobile action vocabulary | implemented | `device-lab-mcp/package.json`, Appium broker validation in `src/device-lab-broker.ts`, mobile tool schemas, Android/iOS Appium test suites, and broker Appium tests. |
| Bounded mobile/device flow runners | implemented | `mobile_run_flow` and `device_run_flow` schemas, flow routing in `device-lab-mcp/src/server.mjs`, and foundation/flow tests. |
| Video recording across supported backends | implemented | Android ADB, iOS Simulator simctl, Windows helper, macOS SSH helper, broker-routed Android/iOS simulator paths, and video recording tests/handoff. |
| File/path/secret policy and provider in-guest transfer hardening | implemented | `device-lab-mcp/src/policy/files.mjs`, `lab-mcp` file policy, file policy tests, Android/Windows/macOS provider transfer tests, `TASK__file-secret-content-policy`, and `TASK__provider-inguest-transfer-hardening`. |
| Lab MCP, container-QEMU provider, workspace/artifact sync, base images, snapshots, reboot, targets, sessions | implemented | `lab-mcp/src/provider.mjs`, `lab-mcp/src/tools.mjs`, `src/lab-runner-admin.ts`, lab-mcp provider/foundation/smoke tests, and lab-runner/container VM commits. |
| Bounded guest SSH, guest exec, guest push/pull, guest-agent status/session/provisioning | implemented | `lab-mcp/src/provider.mjs`, `lab_guest_*` schemas, provider tests, `TASK__lab-mcp-ssh-guest-transport`, `TASK__lab-mcp-guest-exec`, `TASK__lab-guest-agent-session`, and `TASK__lab-guest-agent-provisioning`. |
| CLI support and package integration | implemented | `src/device-lab-admin.ts`, `src/lab-runner-admin.ts`, `src/mcp-forward.ts`, package file tests, admin smoke/prune/cleanup tests, and README/PLAN docs. |
| Zero-configuration default container VM contract | implemented | `src/docker.ts`, `src/lab-runner-admin.ts`, docker/docker-args/lab-runner-admin tests, `ccc labs smoke`, and `TASK__container-native-vm-e2e-contract`. |

## Explicitly Deferred Or Non-Goal Items

| Area | Status | Rationale |
| --- | --- | --- |
| Automatic OS image download for lab VMs | explicit-deferred | PLAN states OS image download is out of scope; users or CI place base images inside lab state. |
| Direct raw host command, Hyper-V, service-manager, filesystem, or VM control for agents | explicit-deferred | PLAN explicitly routes host authority through broker/lab contracts only. |
| iOS trust prompt, Developer Mode, Xcode network pairing, signing/provisioning automation | explicit-deferred | PLAN requires normal Apple/macOS UI workflows and exposes manual-required diagnostics instead. |
| Unsupported physical iOS controls such as power, battery, airplane mode, location simulation, permission mutation, app data clear, open URL, uninstall | explicit-deferred | Backend returns explicit unsupported diagnostics because these are unsafe or unavailable for real hardware through CCC. |
| OCR, target-by-window actions, and richer target-by-element desktop actions | explicit-deferred | PLAN names these as later hardening slices, not current completion blockers. |
| Optional future backend/provider plugins and optional future tools | explicit-deferred | PLAN reserves extension points but does not require all possible future backends before current completion. |
| Full real hardware/macOS/Windows host E2E in ordinary CI | explicit-deferred | Current tests use fake host tools; real-provider smoke is opt-in and reports readiness/inventory without starting devices. |
| Automatic macOS guest SSH credential installation without existing trust | explicit-deferred | PLAN classifies this as manual-required unless an existing trusted SSH channel or image customization step is supplied; CCC may provision its helper over trusted SSH/SCP but must not bypass guest login, TCC, provider prompts, or write `authorized_keys` without that trust boundary. |

## Remaining Implementation Work

No remaining implementation items are currently named by
`PLAN__device-lab-mcp.md`.

## Verification Boundary

This audit separates implementation/contract completion from full real-provider
proof. Source, schema, routing, policy, and fake-provider coverage are current,
but a strict proof run must still execute on hosts that actually provide the
required Android SDK/ADB, Xcode/iOS, Windows Sandbox, macOS VM, KVM, and
physical-device prerequisites. On this Linux container, those prerequisites are
absent, so strict real-provider proof intentionally exits non-zero with
provider SKIPs rather than being treated as complete.

The fixed per-capability completion criteria for Android Emulator and Windows
Sandbox are maintained in
`doc/common/DEVICE_LAB_REAL_CAPABILITY_MATRIX.md`. That matrix, rather than a
percentage estimate, is authoritative for their current live-proof status.

## 2026-07-16 Android And Windows Capability Proof

| Area | Evidence |
| --- | --- |
| Android Emulator complete surface | A real Android 37.1 x86_64 emulator run returned `PASS` with all 52 advertised capabilities in `verifiedCapabilities`. The run exercised lifecycle, ADB, UIAutomator, Appium, recording, transfer, destructive controls, and deterministic fixture-app operations. |
| Windows Sandbox complete surface | A real Windows Sandbox run through host broker `1.1.71` returned `PASS` with all 21 advertised capabilities in `verifiedCapabilities`. Recording start/status/stop produced a non-empty ZIP, and lifecycle cleanup removed the test device. |
| Live defects converted to regressions | Windows guest-helper recording is broker-routed without a nested owner/device lock; explicit helper timeouts override the fast RPC path; ZIP creation uses `System.IO.Compression.ZipFile` instead of the optional PowerShell archive module; helper error responses preserve request type; recording status accepts envelope, nested, and bare state shapes; preflight removes orphaned test-prefix directories. |
| Cleanup evidence | `devices.json` contained no `windows-real-sandbox-*` record after the pass. Nineteen historical test-owned artifact directories were removed, and a second scan returned zero. |
| Physical Android cold-start inventory | A live USB check exposed two nested timeout defects before attachment: the MCP classified `device_inventory` as a one-second fast operation, while the host broker allowed only five seconds for `adb devices -l`. Inventory now uses the ordinary 60-second broker RPC budget and gives ADB at least 15 seconds to cold-start its daemon; focused regression assertions cover both deadlines. |

## Regression Prevention Audit

The 2026-07-08 through 2026-07-16 device-lab history was checked commit by
commit. Every commit in that interval that changed production device-lab code
also changed a unit, integration, or real-provider test. The failures observed
during live Android and Windows work are covered as follows:

| Failure family | Automated prevention |
| --- | --- |
| Broker launch, repair, owner resolution, process identity, and bounded transport | Broker, attach CLI, routing, timeout-bound, process-identity, and real-test preflight suites. |
| Vitest result expansion, duplicate provider runs, package-local execution, and long operation deadlines | Level runner, real capability coverage, package, and timeout-bound suites. |
| Android AVD creation, broker lifecycle result shapes, file transfer location, unsupported airplane-mode behavior, stale instrumentation, Appium startup, and clipboard routing | Android emulator unit/integration suites plus the 52-capability real emulator E2E. |
| Windows Sandbox bootstrap, helper mappings, one-shot recovery, active helper preservation, visible-connect fallback, minimization, screenshot/helper response shapes, recording, and cleanup | Windows backend/broker suites plus the 21-capability real Sandbox E2E. |
| Public fake-device diagnostics and provider identity assertions | Broker Level 2 E2E, broker-routing tests, and public capability matrix assertions. |
| Physical Android ADB daemon cold start | Broker inventory asserts a 15-second minimum provider deadline and MCP timeout bounds assert a 60-second RPC deadline. Host broker `1.1.73` completed live ADB inventory and found USB serial `273834b121017ece`; attach and command proof remain pending because ADB reports `unauthorized` until the user accepts the device-side USB debugging prompt. |

This is regression coverage for known, reproducible defects, not a claim that
future host, OS, driver, or hardware failures are impossible. Real-provider
E2E remains the release gate for behavior that mocks cannot prove.

## Code Minimality Boundary

The pre-squash audit covered unused locals, exports, dependencies, legacy CLI
and MCP aliases, duplicated state wrappers, and fallback paths. It produced a
net reduction of 345 lines and removed 16 installed packages:

- TypeScript now enforces `noUnusedLocals` and `noUnusedParameters`; all 15
  reported unused imports, locals, parameters, and helpers were removed or
  made explicit.
- Unreferenced state wrappers and exports were removed from the device-lab MCP.
- The unused `@vitest/coverage-v8` dependency and its lockfile-only dependency
  graph were removed. `tsx`, Appium packages, MCP entrypoints, and real-test
  scripts remain because tests or string-based dynamic execution use them.
- The unreleased `ccc devices admin ...` and
  `device_image_create`/`device_image_clone` compatibility paths were removed.
  Canonical `--all-projects` and `device_base_image_create`/`clone` contracts
  remain covered.
- Knip production analysis was reviewed rather than applied mechanically. Its
  remaining file reports are dynamic package/script entrypoints, and its
  remaining export reports are public APIs or explicit test seams. Live
  Android and Windows recovery fallbacks remain because real-provider failures
  demonstrated their necessity.

The audit cannot prove that future requirements will never make another path
obsolete. It does establish a reproducible compiler gate, records the dynamic
entrypoint boundary, and removes every candidate that could be proven unused
without weakening an exercised contract.

Latest strict run on this container:

```text
SUMMARY real-tests total=59 pass=40 skip=19 fail=0 failOnSkip=true strictSkipFailures=19
```

The broker-only Level 2 E2E has complete coverage on this host:

```text
SUMMARY real-tests total=29 pass=29 skip=0 fail=0 failOnSkip=true strictSkipFailures=0
```

## Verification

The following verification evidence has been collected:

| Area | Evidence |
| --- | --- |
| Full required common MCP tool list | `npm test`, `npm run test:level0`, and `src/__tests__/device-lab-mcp.foundation.test.ts` passed with tool schema, routing, and foundation coverage. |
| Backend matrix completeness | `npm test`, `npm run test:level1`, `npm run test:level2`, and `npm run test:level3` passed; unavailable real providers skipped with explicit diagnostics on this host. |
| Security invariants | `npm test` passed the file policy, broker auth/allowlist, destructive policy, owner isolation, physical lease, container VM contract, and lab-mcp redaction suites. |
| Stale container wiring boundary | Focused CLI/MCP/docker tests passed. Public CLI output from `ccc devices broker status`, `ccc devices backends`, and `ccc devices smoke` reports incomplete wiring and the host-restart remedy for a stale container; wired fixture tests verify warnings disappear when the host-backed device state mount is present. |
| Real-provider smoke boundary | `ccc devices smoke --real-provider` and `ccc labs smoke` completed as non-starting diagnostics with SKIP results for missing host prerequisites. |
| Build and static checks | `npm run build`, `npm run lint`, and `git diff --check` passed. |

## 2026-07-08 Reverification

| Area | Evidence |
| --- | --- |
| MCP tool exposure and live safe operations | A stdio MCP smoke now lists 81 public tools after hiding low-level broker shutdown/service/RPC/physical/Appium/command diagnostics and legacy image aliases; only `device_broker_status` remains advertised as a broker-prefixed tool. A built `dist/device-lab-mcp/server.mjs` stdio `listTools` check also reports `count=81`, broker tools `["device_broker_status"]`, image tools `["device_base_image_clone","device_base_image_create"]`, and no hidden-tool leaks. The smoke successfully calls `device_backends`, `device_list`, `display_current`, `display_cursor_position`, `display_key`, `display_type`, `display_click`, `display_double_click`, `display_scroll`, `device_run_flow`, and `mobile_session_status`. `src/__tests__/device-lab-mcp.foundation.test.ts` also dispatches every advertised tool name through a safe MCP smoke path and asserts no advertised tool returns an unknown-tool or unexpected-error response. |
| Broker-first owner routing | `src/__tests__/device-lab-mcp.broker-routing.test.ts` covers broker-first routing without local direct fallback; `src/__tests__/device-lab-mcp.broker.test.ts` covers project-owner rejection from `/v1/owner/resolve` and verifies MCP does not continue with a locally computed owner. Container creation no longer injects `CCC_DEVICE_LAB_OWNER_BASIS`; MCP broker RPC must resolve the owner through the host broker, and brokers without `/v1/owner/resolve` fail owner resolution instead of using a local fallback. |
| Canonical direct-provider owner routing | `device-lab-mcp/src/context.mjs` now defaults to the same profile/worktree-aware owner basis as host CCC instead of hostname/cwd. `src/__tests__/device-lab-mcp.owner-context.test.ts` covers canonical default, profile default, and verifies legacy `CCC_DEVICE_LAB_OWNER_BASIS` is ignored by device-lab MCP owner identity. Device-lab real E2E scripts no longer set `CCC_DEVICE_LAB_OWNER_BASIS` for Android emulator, iOS simulator/device, Windows Sandbox, or macOS VM runs. |
| Environment-variable cleanup | Broker child backend invocation no longer passes `CCC_DEVICE_LAB_BACKEND_MODULE_URL`, `CCC_DEVICE_LAB_BACKEND_HANDLER`, `CCC_DEVICE_LAB_TOOL`, or `CCC_DEVICE_LAB_TOOL_ARGS`; it sends the short-lived invocation envelope over stdin JSON instead. Device-lab MCP, broker status, and admin diagnostics no longer expose owner-basis env state as a configuration contract; owner resolution is reported as broker-owned and implicit/direct broker routing is selected per MCP call instead of through a process-wide device-lab env var. |
| Real E2E MCP dispatch | `scripts/real-tests/device-lab-mcp-client.mjs` runs real provider E2E operations through the packaged `device-lab-mcp/server.mjs` stdio transport. Android emulator, Android physical device, iOS simulator/device, Windows Sandbox, and macOS VM real E2E scripts now call MCP tools instead of importing backend handlers directly. Provider real E2E calls use public `backend` arguments rather than hidden broker transport arguments such as `implicitBroker:false`; `src/__tests__/test-level-runner.test.ts` prevents those scripts from regressing to direct handler calls, hidden compatibility tools, or hidden broker transport arguments. |
| Fake-provider and unit gate | `npm run test:level0` passed: 70 files passed, 7 skipped; 1424 tests passed, 50 skipped. The focused real-test/package suite passed: 4 files, 14 tests, 7 skipped. |
| Real-provider gates on this host | `node scripts/test-level.js 3 --node-test` passed with all unavailable providers reported as explicit skips. Earlier `npm run test:level1`, `npm run test:level2`, and `npm run test:level3` also passed with missing Android/Xcode/Windows/macOS providers and destructive prerequisites reported as explicit skips. |
| Build and lint | `npm run build`, `npm run lint`, and full `git diff --check` passed after normalizing modified text files to LF line endings. |
| Containerized Docker git identity E2E | The failing `mounts host git identity into the container` E2E now passes. Host `.gitconfig` is copied into the running container with `docker cp`, avoiding single-file bind mounts that fail when CCC itself talks to a host Docker daemon from inside a container. |

## 2026-07-09 Flow Reverification

| Area | Evidence |
| --- | --- |
| Target-neutral flow clipboard coverage | `device_run_flow` now allows the safe non-destructive `mobile_set_clipboard` step alongside `mobile_get_clipboard`, so a target-neutral flow can prepare and verify mobile clipboard state. `src/__tests__/device-lab-mcp.foundation.test.ts` covers a two-step set/get clipboard flow and asserts neither step is rejected by the flow allowlist. |

## 2026-07-09 Broker Contract Reverification

| Area | Evidence |
| --- | --- |
| Broker health versus owner RPC readiness | `device_broker_status` now reports `rpcReady` and `ownerResolve` in addition to health probe data. A reachable broker that lacks the required `/v1/owner/resolve` owner contract is reported as `host-broker-detected` with `rpcReady:false`, warning, and restart/upgrade remedy instead of appearing fully usable. `src/__tests__/device-lab-mcp.broker.test.ts` covers this health-only broker case. |
| Stopped Android status observation | Broker-backed `device_status` treats a missing ADB target as the expected observation when the owner record is already `stopped`, returning a successful stopped/readiness result while preserving the failed probe in execution diagnostics. Running records and mutating lifecycle command failures still fail closed. The required `stopped-android-status-observation-v1` capability prevents current clients and host CCC readiness repair from silently reusing a broker with the old 502 behavior. |

## 2026-07-09 Strict Proof Reverification

| Area | Evidence |
| --- | --- |
| Broker-only real E2E | `node scripts/real-tests/run.mjs --fail-on-skip scripts/real-tests/level2-broker-e2e.mjs` passed with `total=29`, `pass=29`, `skip=0`, `fail=0`, and `strictSkipFailures=0`. |
| Current-display real E2E | `node scripts/real-tests/run.mjs --fail-on-skip scripts/real-tests/level1-display-e2e.mjs` passed with `total=9`, `pass=9`, `skip=0`, `fail=0`, and `strictSkipFailures=0`, exercising `display_current`, cursor position, screenshot, click, double-click, key, type, scroll, and `device_run_flow` through the device-lab MCP stdio transport. The test validates action response text for click, double-click, key, type, and all scroll directions, and verifies `device_run_flow` returned successful `display_current` and `display_cursor_position` step results with expected content. |
| Machine-readable proof summary | `scripts/real-tests/run.mjs --json-summary` now emits a final `JSON_SUMMARY` line with total/pass/skip/fail counts, `strictSkipFailures`, and per-test/per-step records. `--json-summary-file <path>` writes the same payload as a durable artifact, and `scripts/test-level.js` forwards both JSON options while selecting the node real-test runner. `src/__tests__/test-level-runner.test.ts` verifies the JSON summary for pass/skipped-step records, file output, and dry-run forwarding. `node scripts/test-level.js 2 --fail-on-skip --json-summary-file <tmp>/level2-summary.json` produced an artifact with `total=59`, `pass=40`, `skip=19`, `fail=0`, `strictSkipFailures=19`, and 59 per-step records on this host. |
| Proof gap summarizer | `scripts/real-tests/summarize-json.mjs <summary.json>` groups JSON proof artifacts by skipped and failed reason, and `scripts/test-level.js --summarize-json <summary.json>` exposes the same summarizer from the main real-test entrypoint. `src/__tests__/test-level-runner.test.ts` covers skip/fail grouping and the CLI wrapper. On the current Level 2 artifact, the largest skip groups are `not a macOS host` (4), `missing adb` (3), `missing adb, emulator` (2), `missing xcrun` (2), and `/dev/kvm is not available` (1). |
| Full strict real-provider gate | `node scripts/test-level.js 2 --node-test --fail-on-skip` correctly exited non-zero on this container with `total=59`, `pass=40`, `skip=19`, `fail=0`, and `strictSkipFailures=19` because `adb`, `emulator`, `xcrun`, `wsb`, macOS VM providers, and `/dev/kvm` are unavailable here. This is a missing-provider proof gap, not a test failure. |
| Full unit/integration gate | `npm test` passed with 70 files passed, 7 skipped; 1477 tests passed, 51 skipped. `npm run lint` also passed. |
| Focused device-lab unit/integration gate | `npx vitest run src/__tests__/device-lab*.test.ts src/__tests__/device-lab-mcp*.test.ts src/__tests__/package.test.ts src/__tests__/test-level-runner.test.ts --reporter=dot` passed with 31 files passed, 5 skipped; 301 tests passed, 19 skipped. |
| Broker command surface | Public service-manager install/uninstall/start/stop actions are removed from CLI/MCP surfaces. Low-level service-manager diagnostics are hidden from normal MCP tool discovery, and normal recovery goes through host CCC broker readiness reconciliation plus `ccc devices broker status`. |
| Public MCP schema surface | Public `TOOLS` schemas no longer advertise broker transport knobs (`broker`, `viaBroker`, `implicitBroker`, `autolaunch`, host candidates, broker ports, or broker timeout tuning), `device_broker_status` does not advertise shutdown, and low-level broker diagnostic tools are hidden from normal tool discovery. Provider real E2E scripts are guarded to call public device-lab tool names and public arguments only. The pre-release `device_image_create`/`device_image_clone` aliases were subsequently removed entirely during the squash audit; only `device_base_image_create`/`device_base_image_clone` remain. Normal agents see domain arguments only. |
| Public broker status repair path | `devicesCliAsync(["broker", "status"], ...)` routes the user-facing `ccc devices broker status` path through broker readiness repair before printing status, so users do not choose service install/uninstall/start/stop verbs. The public CLI rejects manual service verbs with the automatic-repair diagnostic. `npx vitest run src/__tests__/device-lab-broker.attach-cli.test.ts src/__tests__/device-lab-mcp.broker-routing.test.ts src/__tests__/device-lab-mcp.foundation.test.ts --reporter=dot` passed with 3 files and 56 tests. |

## 2026-07-13 Broker State Isolation Reverification

| Area | Evidence |
| --- | --- |
| Operator command boundary | User-facing recovery and status instructions use `ccc devices broker status`; direct `dist/index.js` execution is documented as repository-internal only. |
| Broker E2E state isolation | The explicit-autolaunch broker E2E now assigns an isolated temporary `HOME` and `USERPROFILE`, uses `brokerPort` separately from provider `port`, and removes the temporary state on completion. A 32-step broker E2E passed with zero skips/failures while the shared host runtime file SHA-256 remained unchanged before and after the run. |
| Stale Linux child handling | MCP-owned broker process checks treat Linux `/proc/<pid>/stat` state `Z` as exited, preventing zombie children from preserving stale test runtime metadata or blocking replacement. |
| Regression and package gates | Focused broker/runner tests passed with 3 files and 115 tests. `npm test` passed with 72 files passed, 7 skipped, 1545 tests passed, and 50 platform skips. `npm run build`, `npm run lint`, bundled installed-MCP smoke (81 public tools), `npm pack --dry-run --json`, and `git diff --check` passed. |

## 2026-07-13 Appium Runtime Supply-Chain Reverification

| Area | Evidence |
| --- | --- |
| Production dependency audit | The broker-managed Appium runtime now resolves Appium 3.5.2, UiAutomator2 8.1.0, XCUITest 11.17.6, MCP SDK 1.29.0, Appium base-driver 10.7.1, Appium support 7.2.5, `form-data` 4.0.6, and `morgan` 1.11.0. `npm audit --omit=dev --json` reports zero vulnerabilities for both the root package and `device-lab-mcp`. |
| Clean install reproducibility | The Appium lockfile was regenerated from its current manifest instead of incrementally retaining stale platform-specific optional dependencies. A separate temporary directory completed `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, installed 844 packages, and ran the installed Appium entrypoint as version 3.5.2. Package regression coverage checks the runtime versions and every locked `sharp` platform package against `sharp`'s exact optional-dependency contract. |
| Regression and release gates | Appium/package-focused tests passed with 3 files and 44 tests. The full suite passed with 72 files passed, 7 skipped, 1546 tests passed, and 50 platform skips. `npm run build`, `npm run lint`, `npm pack --dry-run --json`, and `git diff --check` passed. |

## 2026-07-13 CLI and Broker Boundary Reverification

| Area | Evidence |
| --- | --- |
| Packaged informational CLI | A tarball installed into a temporary global prefix now returns `1.1.61` from `ccc --version` and help from `ccc @feature --help` without creating broker runtime or container state. Previously, `--version` fell through to the default AI-tool path and created a project container. Unit and packaged-process regression tests cover `-v`, `--version`, `version`, help aliases, worktree-prefixed informational calls, and tool-specific flag pass-through. |
| Owner authentication hardening | Broker RPC auth now requires an existing valid owner-secret record, compares the derived token with `timingSafeEqual`, and rejects unknown-owner probes without creating auth files. Secret provisioning uses an owner lock plus atomic replacement, validates the persisted `ownerId`, immediately reclaims dead-PID locks, and removes abandoned owner temp files. A packaged-process regression starts 16 Node processes at one barrier and proves they all receive one secret with no lock/temp residue. |
| Concurrent state integrity | Mutating RPCs for one owner are serialized while read-only RPCs remain outside the mutation queue. Broker runtime metadata and broker/provider `devices.json` records are written to private temporary files and atomically renamed with bounded Windows sharing-violation retries. A second 16-process regression concurrently writes differently sized provider records and proves the final state is complete JSON from exactly one writer with no temp residue. Brokers advertise and clients require `atomic-owner-secret-provisioning-v1`, `owner-mutation-serialization-v1`, and `atomic-owner-device-state-v1`. |
| RPC fault containment | Unexpected provider/RPC exceptions return only `broker-internal-error`; the exception detail is not exposed and the same broker continues serving `/health`. Focused broker/CLI/package tests passed with 4 files and 120 tests. |
| Authenticated broker E2E | The isolated Level 2 broker MCP E2E passed all 32 steps with zero skips/failures after the auth, state-integrity, and fault-containment changes, including autolaunch, owner resolve, authenticated echo, inventory, lifecycle, Appium diagnostics, public wrapper routing, session ownership, and process cleanup. |
| Dependency audit | `npm audit --omit=dev --json` reports zero vulnerabilities for the root production graph and separately for the 940-package `device-lab-mcp` production/optional graph. |
| Full regression gate | `npm test` passed with 72 files passed, 7 skipped, 1566 tests passed, and 50 platform skips. `npm run build`, `npm run lint`, the 141-file package dry-run, and `git diff --check` passed. |

## 2026-07-13 Shared Host State Reverification

| Area | Evidence |
| --- | --- |
| Cross-owner physical leases | Direct providers and the host broker now serialize claim, heartbeat, prune, and release through the same per-hardware mutation lock. Lease records are atomically replaced and carry a stable `claimId`; a recovered expired lease receives a new claim. Aggregate lease updates use a separate backend-wide mutation lock, preventing concurrent owners from dropping each other's entries. |
| Singleton fencing | Direct and broker Windows Sandbox paths serialize claim, runtime-ID update, and release through one host-wide mutation lock. Singleton records are atomically replaced and carry `claimId`, so diagnostics distinguish one host claim from a later claim. |
| Crash recovery | Mutation locks include a random token, PID, host, and boot ID. Release and stale cleanup first move the lock and verify its token before deletion, malformed locks receive a bounded recovery grace period, live same-boot owners are not reclaimed, and restart recovery does not rely on PID identity alone. |
| Concurrent regression | A 16-process test preserves all distinct-owner aggregate entries, then runs a 16-way claim race for one hardware ID and proves exactly one winner, 15 conflicts, valid JSON, unique claim metadata, and no mutation-lock residue. The full suite passed with 73 files passed, 7 skipped, 1569 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures. |
| Release gates | `npm run build`, `npm run lint`, `git diff --check`, and the 142-file package dry-run passed. Root and `device-lab-mcp` production audits both report zero vulnerabilities. |

## 2026-07-13 Admin Shared-State Reverification

| Area | Evidence |
| --- | --- |
| Admin mutation protocol | Owner and all-owner stop/delete/cleanup/prune paths no longer unlink physical lease or Windows Sandbox singleton records directly. They acquire the same shared mutation lock as direct providers and the host broker, then reread and revalidate the current owner/device/sandbox identity before deletion. |
| Cross-project CLI vocabulary | Public cross-project operations use `ccc devices <list|stop|prune> --all-projects`. This exposes the actual scope without the redundant `admin ... --all` vocabulary. The former admin spellings remain deprecated, hidden compatibility aliases. |
| Successor fencing | Independent-process race regressions hold each shared lock, replace the original record with a successor owner's claim while admin waits, and prove admin preserves both successor records and leaves no mutation-lock residue. |
| Shared implementation | Host broker and admin code use one TypeScript shared-state module for token-fenced mutation locking and atomic JSON replacement. Admin `devices.json` writes now use atomic replacement rather than truncating the live file. The direct-provider ESM implementation remains wire-compatible across the package boundary. |
| Regression and release gates | Focused admin/broker/lock tests passed with 4 files and 49 tests. The full suite passed with 73 files passed, 7 skipped, 1571 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures. `npm run build`, `npm run lint`, `git diff --check`, and the 144-file package dry-run passed; the tarball includes `dist/device-lab-shared-state.js` and its declaration. |

## 2026-07-13 Owner State Serialization Reverification

| Area | Evidence |
| --- | --- |
| Cross-process state contract | Broker, direct providers, and admin commands use the same owner/backend `devices.mutation.lock` and atomically replace `devices.json` only after rereading the current array inside the lock. Create/attach, targeted metadata updates, lifecycle status changes, cleanup, detach/delete, and prune preserve unrelated concurrent records. |
| Compatibility fencing | Brokers advertise and MCP clients require `cross-process-owner-state-serialization-v1`. A current client will not reuse a broker that only serializes mutations inside one broker process. |
| Concurrent regression | A 16-process direct-provider race appends 16 distinct devices and proves all records survive with no lock/temp residue. An independent-process admin race adds a device while deletion waits on the same lock and proves only the requested device is removed. |
| Regression and release gates | The full suite passed with 73 files passed, 7 skipped, 1573 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures. `npm run build`, `npm run lint`, `git diff --check`, and the 144-file package dry-run passed. |

## 2026-07-13 Owner Device Identity Fencing Reverification

| Area | Evidence |
| --- | --- |
| Atomic identity claim | Direct providers and the host broker claim owner/backend device identity while holding `devices.mutation.lock`. Device ID plus backend-specific virtual or physical identity is checked against the latest state before append. Whole-state write/mutate APIs also reject duplicate non-empty device IDs as defense in depth. |
| Provider-safe conflict handling | Android and iOS physical attach release their own lease when state claim loses. Android AVD, iOS Simulator, and macOS image/clone paths roll back only a resource not referenced by the winning record; a shared winning AVD/VM instance is preserved. macOS VM identity uses the composite `(provider, providerInstance)` key, and broker `provider:auto` is persisted as the resolved Tart provider. Windows Sandbox configuration is written only after its state claim succeeds and the exact new record is removed if config persistence fails. |
| Compatibility fencing | Brokers advertise and MCP clients require `owner-device-identity-fencing-v1`, preventing a current client from silently reusing an append-after-precheck broker. Fake broker compatibility fixtures and missing-capability diagnostics cover the new requirement. |
| Concurrent regression | A 16-process same-ID race proves exactly one claim succeeds, 15 callers return `owner-device-id-conflict`, one valid record remains, and no lock/temp residue survives. Direct Android fake-SDK and broker command tests inject an external winner during AVD creation, verify the losing unique AVD is deleted, and prove the winner record remains unchanged. |
| Physical attach operation fencing | Physical attach assigns a per-operation nonce in addition to the stable lease claim ID. An active lease cannot be rebound to another same-owner device or reused by a concurrent same-owner attach, and heartbeat, rollback, detach, and cleanup mutate the lease only when the persisted claim tokens match. Brokers advertise and MCP clients require `physical-lease-operation-fencing-v1`. Direct-store and authenticated broker regressions prove stale operations cannot refresh or release a successor lease. |
| Regression and release gates | The full suite passed with 73 files passed, 7 skipped, 1579 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures. `npm run build`, `npm run lint`, bundled installed-MCP smoke passed with 81 public tools, the 144-file package dry-run passed, and `git diff --check` passed. |

## 2026-07-13 Runtime Cleanup Failure Preservation

| Area | Evidence |
| --- | --- |
| Appium replacement and stop | Forced Appium replacement now aborts before launching a successor when the existing broker-owned process cannot be terminated. Explicit stop and failed readiness recovery preserve the persisted Appium record on termination failure; default non-Windows process handling waits for exit and uses a bounded owned-PID force-stop fallback. |
| Owner cleanup | Owner cleanup clears Appium or recording metadata only after its process signal succeeds. Physical records remain attached when exact claim-token lease release fails, preserving enough state for diagnosis and retry instead of reporting a false cleanup success. |
| Compatibility fencing | Brokers advertise and MCP clients require `runtime-cleanup-failure-preservation-v1`, preventing current clients from reusing a broker with lossy cleanup semantics. Focused broker, Appium, MCP compatibility, and routing regressions passed with 4 files and 100 tests. |
| Regression and release gates | The full suite passed with 73 files passed, 7 skipped, 1580 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures. `npm run lint`, bundled installed-MCP smoke with 81 public tools, the 144-file package dry-run, `git diff --check`, and the personal-path diff scan passed. |

## 2026-07-14 Appium Runtime Generation Fencing

| Area | Evidence |
| --- | --- |
| Runtime identity | Every broker-launched or explicitly recorded Appium runtime receives a random 128-bit `runtimeId`. Legacy records fall back to a bounded process/server/update identity comparison during transition. |
| Recorded metadata boundary | `broker.appium.record` remains metadata-only. Caller-supplied URLs and PIDs are reportable but cannot authorize WebDriver proxying or process signals; those require complete broker-launch provenance and exact process identity. |
| Conditional transitions | Appium start, stop, readiness recovery, WebDriver session creation, forced session replacement, stale-session cleanup, and session deletion mutate owner state only when the current runtime generation matches the one observed before the external operation. A concurrent successor remains intact. |
| Orphan rollback | A start that loses the state race terminates only its newly launched broker-owned process. A WebDriver session create that loses the race sends a bounded `DELETE` for only the newly returned session ID, preventing an untracked remote session. |
| Windows process provenance | Port-listener and detached-child cleanup accepts only Appium command lines rooted in the CCC-managed runtime or package installation. Existing broker metadata no longer broadens an unrelated Appium installation into a termination target. |
| Compatibility and regression | Brokers advertise and MCP clients require `appium-runtime-generation-fencing-v1`. Focused race regressions inject successor metadata during process launch, process termination, and WebDriver session creation, proving the successor survives and losing resources are rolled back. |
| Regression and release gates | Focused broker/Appium/MCP compatibility tests passed with 4 files and 103 tests. The full suite passed with 73 files passed, 7 skipped, 1583 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps, installed-MCP smoke passed with 81 public tools, and `npm run lint`, the 144-file package dry-run, `git diff --check`, and the personal-path diff scan passed. |

## 2026-07-14 Cross-Process Device Operation Serialization

| Area | Evidence |
| --- | --- |
| Shared async operation lock | Broker and direct-provider lifecycle paths use the same token-fenced lock at `owners/<owner>/<backend>/operations/<sha256(device-id)>.lock`. The async primitive holds ownership until awaited work settles, releases on rejection, and reports acquisition timeout with the stable `shared-mutation-lock-timeout` code. |
| Short state mutation boundary | Owner cleanup and lifecycle auxiliary cleanup read state before external provider/process work, then hold `devices.mutation.lock` only for a compare-and-set update. Provider commands, process signals, physical lease release, and Sandbox watchdog cancellation no longer execute while the device state file lock is held. |
| Successor preservation | Cleanup rereads the target under the device operation lock and conditionally persists only when the current record still matches the observed record. A concurrent successor is preserved and returned as `stateConflict` instead of being overwritten by stale cleanup metadata. |
| Compatibility fencing | Brokers advertise and MCP clients require `cross-process-device-operation-serialization-v1`, preventing a current direct provider from sharing state with a broker that lacks the same lifecycle/cleanup lock protocol. |
| Focused regression | The final shared-lock and owner-cleanup focused run passed with 2 files and 28 tests, including async hold/release/timeout behavior and concurrent successor preservation. Broker/MCP compatibility, lifecycle, and test-level coverage also passed in the full gate. |
| Regression and release gates | The full suite passed with 73 files passed, 7 skipped, 1587 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures, installed-MCP smoke passed with 81 public tools, and `npm run lint`, the 144-file package dry-run, and `git diff --check` passed. |

## 2026-07-14 Device Runtime Operation Serialization

| Area | Evidence |
| --- | --- |
| Shared runtime lock | Broker recording start/stop and Appium process, metadata, WebDriver session, and request routes use the same per-owner/backend/device operation lock as lifecycle and cleanup. Direct Android, Android physical, iOS Simulator, Windows Sandbox, and macOS VM recording mutations use the matching lock path. |
| Recording generation | Broker-owned recordings carry a random 128-bit `runtimeId`. Start and stop conditionally update only the generation observed before external process work, preserving a concurrent successor and signaling only a losing newly launched recorder. Legacy records use a bounded identity comparison. |
| Deadlock avoidance | Appium session ensure calls the unlocked server-start implementation while its top-level request owns the device operation lock, so the compound operation is atomic without recursive lock acquisition. Lock acquisition timeout remains the stable `device-operation-lock-failed` broker response. |
| Compatibility fencing | Brokers advertise and MCP clients require `cross-process-device-runtime-serialization-v1`; current clients reject brokers that serialize lifecycle but can still race recording or Appium runtime work. |
| Focused regression | Recording start and stop race tests inject an uncoordinated successor during external work and prove successor preservation plus losing-process rollback. Existing Appium start, stop, and session generation races continue to pass under shared operation serialization. |
| Regression and release gates | The full suite passed with 73 files passed, 7 skipped, 1589 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures, installed-MCP smoke passed with 81 public tools, `npm run lint` passed, and the 144-file package dry-run and `git diff --check` passed. |

## 2026-07-14 Direct Recording Generation Fencing

| Area | Evidence |
| --- | --- |
| Direct-provider compare-and-set | Android emulator, Android physical, iOS Simulator, Windows Sandbox, and macOS VM recordings carry a random `runtimeId`. Start commit, stop cleanup, natural-exit callbacks, and status reconciliation mutate only the generation they observed. |
| Early-exit and conflict rollback | Spawn-backed recorders install their exit observer before readiness, conditionally commit state, and verify liveness after commit. A losing start stops only its new process; a stale stop preserves successor metadata. Windows helper starts issue a matching session stop when state commit loses. |
| Snapshot serialization | macOS snapshot create, restore, and delete share the lifecycle and runtime per-device operation lock, preventing provider clone and owner-state races with start, stop, recording, or cleanup. |
| Compatibility fencing | Brokers advertise and MCP clients require `direct-recording-generation-fencing-v1`, so a current MCP rejects a broker that lacks direct recording generation semantics. |
| Regression | Runtime-generation unit tests cover runtime ID precedence, legacy identity matching, and stale-successor preservation. Provider recording tests require runtime IDs, and a macOS lock regression proves snapshot calls wait behind an existing device operation. |
| Release gates | The full suite passed with 74 files passed, 7 skipped, 1593 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, `npm run lint` passed, and the 145-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Finite Device Operation and Direct Appium Fencing

| Area | Evidence |
| --- | --- |
| Finite operation policy | Direct-provider exec, screenshot, transfer, install, reset, input, and clipboard operations use one backend-aware policy and the shared per-device cross-process lock. Status and bounded wait tools remain outside the long-held lock. |
| Reentrant lock lifetime | Awaited aliases may reenter the same device operation without deadlock. The async context carries an active ownership token that expires as soon as the parent operation settles, forcing detached descendants to reacquire the real file lock. |
| Direct Appium generation | iOS Simulator and physical-device Appium metadata carries a random `runtimeId`. Start commit, stale recovery, natural exit, and cleanup are compare-and-set transitions, so a stale callback cannot clear a successor even when the PID is reused. |
| Process ownership | Cleanup signals only Appium processes launched by the direct provider with a current runtime generation and exact live process identity. Endpoint reachability is not PID ownership proof. Legacy and external metadata is cleared or reused without treating a stored PID as ownership proof. Unused Android direct Appium bootstrap code and blind Android Appium PID signaling were removed. |
| Compatibility fencing | Brokers advertise and MCP clients require `finite-device-operation-serialization-v1` and `direct-appium-generation-fencing-v1`. Focused provider, lock, generation, broker, routing, and compatibility tests passed with 10 files and 113 tests. |
| Release gates | The full suite passed with 76 files passed, 7 skipped, 1608 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, `npm run lint` passed, and the 146-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Direct Runtime Process Identity Fencing

| Area | Evidence |
| --- | --- |
| Persisted identity | Spawn-backed Android emulator, Android physical, iOS Simulator, and macOS VM recordings persist a random runtime generation, PID, operating-system process start token, and SHA-256 command hash. Raw process command lines are not written to owner state. |
| Signal ownership | A process restored from state is signaled only when its live PID, start token, and command hash all match. Reused PIDs, legacy metadata, and incomplete identity do not authorize a host signal. Status reconciliation clears current-format metadata whose PID now belongs to another process. A losing newly spawned recorder is stopped through its live `ChildProcess` handle. |
| Provider lifecycle | Android emulator stop relies on target-scoped `adb emu kill` rather than a persisted emulator PID. Android and macOS recording stops retain provider-side termination while using local PID signaling only as an identity-proven assist. iOS Simulator explicit recording stop preserves active state when a live PID belongs to a different process. |
| Compatibility fencing | Brokers advertise and MCP clients require `direct-runtime-process-identity-v1`, preventing a current client from silently reusing a broker that still trusts persisted recording PIDs. |
| Focused regression | Process-identity, direct-provider, broker, routing, and compatibility tests passed with 10 files and 102 tests before the full release gate. |
| Release gates | The full suite passed with 77 files passed, 7 skipped, 1611 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, `npm run lint` passed, and the 147-file package dry-run, personal-path scan, tracked-dist check, and `git diff --check` passed. |

## 2026-07-14 Host Recording Process Identity Fencing

| Area | Evidence |
| --- | --- |
| Persisted broker identity | Default-runner host-broker recordings persist a random runtime generation, PID, operating-system process start token, and SHA-256 command hash. Raw command lines are not persisted or returned. |
| Signal ownership | Explicit recording stop, lifecycle cleanup, owner cleanup, and conflict rollback signal only a recording created by the host broker whose live PID, start token, and command hash exactly match. Injected command runners remain simulated and never signal their synthetic PIDs. |
| PID reuse recovery | Recording status conditionally clears stale metadata when the recorded PID now identifies another process. An explicit stop against a reused PID returns `recording-stop-signal-failed`, does not invoke provider cleanup, does not signal the PID, and preserves the recording generation for diagnosis. |
| Administrative cleanup | Admin cleanup no longer signals persisted device or Appium PIDs and does not trust legacy recording PIDs. Provider-scoped commands stop devices and remote recorders; a local recording process is signaled only when complete runtime identity proves ownership. |
| Compatibility fencing | Brokers advertise and MCP clients require `host-recording-process-identity-v1`, preventing a current client from reusing a broker that still trusts persisted host-recording PIDs. |
| Focused regression | Process-identity, broker command, owner cleanup, admin cleanup, MCP routing, and compatibility tests passed across 7 files and 173 tests. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1618 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, `npm run build` and `npm run lint` passed, and the 149-file package dry-run, personal-path scan, tracked-dist check, and `git diff --check` passed. |

## 2026-07-14 Runtime Process Observation Recovery

| Area | Evidence |
| --- | --- |
| Observation states | Shared TypeScript and direct-provider ESM helpers classify runtime observation as `match`, `mismatch`, `exited`, or `unavailable` by combining hashed process identity with an independent PID liveness probe. |
| Conservative recovery | Failed CIM, `/proc`, or `ps` identity reads no longer clear a recording merely because the identity is unavailable. A live or indeterminate PID preserves the current generation; confirmed exit and exact PID reuse remain recoverable stale states. |
| Signal races | A matching process that exits immediately before the signal is treated as already exited only when the OS reports `ESRCH`. Permission and other signal failures remain explicit failures with retryable state. |
| Provider behavior | Android emulator, Android physical, iOS Simulator, macOS VM, and host-broker recording status share the conservative observation contract. iOS explicit recording stop now preserves state for every unsafe no-signal result and accepts only confirmed prior exit. |
| Compatibility fencing | Brokers advertise and MCP clients require `runtime-process-observation-v1`, preventing a current client from reusing a broker that conflates process identity lookup failure with exit. |
| Focused regression | Process identity, iOS recording, broker command, and compatibility tests passed with 6 files and 112 tests. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1621 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, `npm run build` and `npm run lint` passed, and the 149-file package dry-run, personal-path scan, tracked-dist check, and `git diff --check` passed. |

## 2026-07-14 Host Appium Process Identity Fencing

| Area | Evidence |
| --- | --- |
| Persisted process identity | A default-runner host Appium launch waits for a stable child process and persists a random runtime generation, PID, operating-system start token, and SHA-256 command hash. Raw command lines are never persisted or returned. The detached launcher now preserves the requested environment and working directory, and creates the managed runtime directory before a directly discovered Appium executable is launched. |
| Strict process provenance | Host signaling requires `authority=host-broker`, `processOwner=host-broker`, `startedBy=broker.appium.start`, a runtime generation, and exact live process identity. Caller-recorded metadata, partial provenance, legacy live metadata, reused PIDs, and unavailable identity do not authorize a signal. Injected test runners remain simulated and never signal synthetic PIDs. |
| Conservative recovery | Reuse requires the launch policy and exact live identity. Stop, forced replacement, readiness cleanup, rollback, lifecycle cleanup, and owner cleanup preserve metadata on identity mismatch or observation failure. Legacy metadata is cleared without signaling only when an independent liveness probe confirms that the PID exited. |
| Windows process trees | The broker verifies the persisted Appium parent identity before `taskkill /T`. A separate managed port listener must pass both managed-command validation and fresh process-identity capture before any parent or listener tree is terminated, preventing partial cleanup after an unverifiable listener. |
| Compatibility fencing | Brokers advertise and MCP clients require `host-appium-process-identity-v1`, preventing a current client from reusing a broker that still trusts persisted Appium PIDs. |
| Focused regression | Appium, broker, MCP routing, and compatibility tests cover real default-runner identity persistence, exact stop, PID mismatch, live identity lookup failure, partial provenance, injected-runner isolation, generation conflicts, and direct provider-path startup. The focused compatibility run passed 4 files and 108 tests; the Appium MCP integration passed all 8 tests. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1625 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, `npm run build` and `npm run lint` passed, both production audits reported zero vulnerabilities, and the 149-file package dry-run and `git diff --check` passed. |

## 2026-07-14 Broker-Owned Owner Auth Provisioning

| Area | Evidence |
| --- | --- |
| Single provisioning authority | A validated `/v1/owner/resolve` provisions or repairs only the exact resolved owner through the host broker's lock and atomic-write path. MCP clients no longer generate, replace, rotate, or chmod owner secrets; arbitrary owner RPC probes still cannot create auth state. |
| Auth path fencing | Broker and MCP readers open auth metadata without following links where the platform supports it, then require a regular single-link file and verify that the open descriptor and path identify the same file. The broker quarantines invalid regular files, symbolic links, and hard links before atomic replacement without modifying external targets. |
| Concurrent regression | Twelve independent MCP processes connect concurrently to a real broker from empty auth state, authenticate through one broker-owned secret, and leave no auth lock residue. Separate regressions prove owner-mismatched and linked metadata are never trusted or rewritten by MCP clients. |
| Compatibility contract | Brokers advertise and clients require `broker-owned-owner-secret-provisioning-v1`. A read-only current MCP client therefore replaces an older shared broker that provisioned only its launch owner and depended on clients to create later owner secrets. |
| Focused regression | Type checking passed and the broker, MCP broker, broker-routing, and package regressions passed with 4 files and 96 tests. A final broker/MCP auth run, including abandoned linked-artifact recovery, passed with 2 files and 57 tests. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1630 tests passed, and 50 platform skips. The isolated authenticated broker E2E passed all 32 steps with zero skips/failures, installed-MCP smoke passed the bundled public-tool contract, `npm run build` and `npm run lint` passed, both production audits reported zero vulnerabilities, and the 149-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Host Broker Replacement Process Identity Fencing

| Area | Evidence |
| --- | --- |
| Signal authority | Status responses and persisted runtime files no longer authorize process termination. The host CLI resolves the operating-system owner of the requested listening port and requires an exact CCC broker serve command with the same `--port` before signaling. |
| Metadata preservation | A claimed PID that does not match the observed port owner leaves shared runtime metadata unchanged and returns `unverified-broker-port-process`. Compatibility inspection cannot promote an unverified status response into trusted runtime state. |
| MCP recovery | MCP-owned child handles remain valid in-process ownership evidence. Recovery of older MCP runtime state and explicit shutdown otherwise require the same OS port-owner and command identity proof. MCP never terminates a `ccc-host` runtime directly. |
| Adversarial regression | Host tests cover conflicting status, persisted, and unrelated port-owner PIDs without signaling any claimed process. MCP integration points forged runtime metadata at the test runner PID and proves recovery refuses to signal it or delete its metadata. |
| Compatibility contract | Brokers advertise and clients require `host-broker-port-process-identity-v1`, preventing current clients from reusing a broker whose replacement path trusts claimed runtime PIDs. |
| Focused regression | Type checking and the broker, MCP broker, broker-routing, and package regressions passed with 4 files and 97 tests. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1631 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E runs passed, installed-MCP smoke passed all 81 public tools, `npm run lint` passed, both production audits reported zero vulnerabilities, and the 149-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Direct Appium Process Identity and HTTP Bounds

| Area | Evidence |
| --- | --- |
| Persisted process identity | Direct iOS Simulator and physical-device Appium launches persist a random runtime generation, PID, OS start token, and SHA-256 command hash. A shell-to-runtime `exec` transition may refresh the command hash only while PID and start token still identify the same spawned process epoch. |
| Signal ownership | Stale recovery, explicit stop, startup rollback, and superseded-start cleanup signal only exact direct-provider process identity. Every SIGINT, SIGTERM, and SIGKILL escalation rereads identity; PID reuse or unavailable identity stops escalation and preserves retryable state. |
| State races | A natural-exit callback may clear the observed Appium generation before explicit stale cleanup commits. That already-cleared state is accepted, while any different successor generation still blocks cleanup. |
| HTTP bounds | Every direct iOS Appium readiness, session, source, screenshot, action, and cleanup request uses an abortable finite timeout. A regression server accepts a connection without responding and proves the request rejects within its configured bound. |
| Compatibility fencing | Brokers advertise and MCP clients require `direct-appium-process-identity-v1`, preventing a current client from reusing a broker that treats a stored direct Appium PID or endpoint reachability as signal authority. |
| Focused regression | Type checking and direct process-identity, iOS Simulator, iOS physical-device, broker, MCP broker, and routing tests passed with 6 files and 103 tests. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1636 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E each passed all 32 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, `npm run build` and `npm run lint` passed, both production audits reported zero vulnerabilities, and the 149-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Public Device Lifecycle CLI

| Area | Evidence |
| --- | --- |
| Public commands | `ccc devices create <backend> <device-id>`, `ccc devices start <device-id>`, and `ccc devices status <device-id>` invoke the authenticated owner-scoped host-broker lifecycle RPC. No operator command requires direct execution of `dist/index.js`. |
| Windows minimization | Windows Sandbox create and start default to minimized mode. `--no-minimized` is the explicit opt-out, and successful starts persist both the requested state and `minimizeConfirmed`. |
| Output boundary | Lifecycle failures print a bounded error, missing prerequisites, and a short detail instead of dumping the complete broker transport object. Status output identifies broker-owned state and the last minimize confirmation rather than claiming continuous window observation. |
| Focused regression | TypeScript checking passed, the host-broker physical/CLI suite passed with 24 tests, and the combined lifecycle/CLI suites passed with 71 tests. Coverage includes authenticated owner RPC, default minimization, explicit visible mode, persisted minimize confirmation, status formatting, ID collision handling, and invalid-option rejection. |
| Release gates | The full Vitest suite completed successfully, `npm run build` and `npm run lint` passed, bundled installed-MCP smoke passed all 81 public tools, the package dry-run contained 149 files, and `git diff --check` passed. Level 3 destructive provider tests were not repeated for this CLI-only slice. |

## 2026-07-14 Public Lifecycle RPC and Physical Lease Fencing

| Area | Evidence |
| --- | --- |
| Public teardown boundary | `ccc devices stop <device-id>` and `ccc devices delete <device-id>` now use the authenticated owner broker RPC, matching create/start/status. They execute under the broker's per-owner/backend/device operation lock instead of racing MCP lifecycle calls through the synchronous direct-provider admin path. |
| Physical lifecycle invariant | Physical stop releases only the exact current owner/device/claim lease, clears claim metadata, and persists `detached`. Physical start requires an `attached` record plus its matching non-expired lease; after stop it returns `physical-device-not-attached` until an explicit attach establishes a new claim. |
| Compatibility fencing | Brokers advertise and MCP clients require `physical-lifecycle-lease-fencing-v1`, preventing current clients from reusing a broker that can restore physical running state without a valid lease. |
| Focused regression | Type checking passed. The broker command and public lifecycle CLI suites passed 72 tests, and the broker/MCP compatibility fixture run completed without failures. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1641 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E runs passed, standalone build and lint passed, installed-MCP smoke passed all 81 public tools, both production audits reported zero vulnerabilities, and the 149-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Physical Attach and Detach Operation Serialization

| Area | Evidence |
| --- | --- |
| Cross-process operation boundary | Authenticated `broker.physical.attach` and `broker.physical.detach` now acquire the same owner/backend/device operation lock as direct MCP lifecycle, Appium, recording, and device-tool operations before provider, lease, or owner-state mutation. |
| Lease, runtime, and state behavior | A regression holds the shared operation lock externally and proves broker attach creates neither provider effects nor a lease before release. The same test proves detach preserves the active lease until release. Detach cleans broker-owned Appium and recording runtimes before releasing the lease or deleting owner state. Cleanup failure, including foreign runtime ownership, returns an error while preserving both records. Detach also refuses a stale claim-token mismatch without deleting either the successor lease or owner device state. Existing state-write failure tests still prove newly claimed leases are rolled back. |
| Compatibility fencing | Brokers advertise and MCP clients require `physical-attach-detach-operation-serialization-v1` and `physical-detach-runtime-cleanup-v1`, preventing current clients from reusing a broker whose physical RPCs bypass the shared lock or orphan auxiliary runtimes during detach. |
| Focused regression | Type checking passed, the physical attach/CLI suite passed all 24 tests, and the broker/MCP compatibility fixture suites completed without failures. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1641 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E runs passed, the suite build and standalone lint passed, installed-MCP smoke passed all 81 public tools, both production audits reported zero vulnerabilities, and the 149-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Physical Runtime Cleanup Lease Fencing

| Area | Evidence |
| --- | --- |
| Public lifecycle ordering | Physical `ccc devices stop/delete` validates the exact owner/device/claim lease before Appium or recording cleanup. Validation, bounded runtime cleanup, lease release, and the lifecycle state transition execute while holding the physical lease mutation lock, so a successor lease cannot appear between validation and cleanup. |
| Owner cleanup ordering | `broker.cleanup.owner` uses the same guard before touching a physical device runtime. A foreign, mismatched, or successor lease preserves attachment status, Appium metadata, recording metadata, and the lease without issuing process signals. |
| Compatibility fencing | Brokers advertise and MCP clients require `physical-runtime-cleanup-lease-fencing-v1`, preventing a current client from reusing a broker that can clean a successor physical runtime from stale owner state. |
| Focused regression | Type checking passed. The lifecycle command, Appium/owner-cleanup, broker status, and MCP compatibility suites passed all 162 tests, including stale physical stop and owner-cleanup lease-conflict cases that prove no provider or process command runs before lease validation. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1641 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E runs passed, the suite build and standalone lint passed, installed-MCP smoke passed all 81 public tools, the personal-path scan and `git diff --check` passed, and this slice changed no dependency manifests. |

## 2026-07-14 Physical Lease State-Write Rollback

| Area | Evidence |
| --- | --- |
| Lifecycle failure ordering | Physical stop/delete keeps the exact owner/device/claim lease until its bounded provider command succeeds. A provider failure or exception therefore leaves both the attached owner record and active lease unchanged. |
| State-write rollback | After successful lease release, a failed owner-state mutation in public stop/delete, explicit detach, or owner cleanup restores the same claim with a renewed expiry and restarts its broker heartbeat while still holding the physical lease mutation lock. The rollback never overwrites an occupied lease path. |
| Release failure behavior | Lease-file removal occurs before heartbeat cancellation. If removal fails, the existing lease retains its heartbeat instead of silently expiring while owner state still reports an attachment. |
| Failure contract | A successfully restored lease returns `owner-state-write-failed`; a failed or path-conflicted restoration returns `physical-lease-rollback-failed`. Owner cleanup reports the same result under `stateWrite` and counts it as a failed cleanup without claiming a changed device. |
| Compatibility fencing | Brokers advertise and MCP clients require `physical-lease-state-write-rollback-v1`, preventing a current client from reusing a broker that can orphan a physical attachment after persistence failure. |
| Focused regression | Lifecycle, detach, owner-cleanup, broker compatibility, and MCP routing regressions inject real owner-directory write failures and verify exact claim restoration, renewed expiry, preserved attached state, provider-failure preservation, successful retry, and final lease cleanup. |
| Release gates | The full suite passed with 78 files passed, 7 skipped, 1644 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E each passed all 32 steps with zero skips/failures, standalone build and lint passed, installed-MCP smoke passed all 81 public tools, both production audits reported zero vulnerabilities, and the 149-file package dry-run and `git diff --check` passed. |

## 2026-07-14 Owner Device State Validation

| Area | Evidence |
| --- | --- |
| Fail-closed reads | Direct MCP, host broker, and `ccc devices` admin paths share the same owner-state contract: only a missing file is empty. Malformed JSON, invalid structure or entries, duplicate IDs, oversized files, read failures, symbolic links, hard links, and path replacement races stop the operation with a stable state error. |
| Mutation preservation | Every read-modify-write validates the current file while holding `devices.mutation.lock`. Whole-state direct writes also validate an existing file first, so recovery requires an explicit operator action rather than silently replacing evidence of corruption. Regression tests compare the original bytes after failed read, mutation, whole-state write, broker create, and admin prune attempts. |
| Bounded writes | Direct, broker, and admin writers measure the exact pretty-printed UTF-8 payload before atomic replacement. A mutation that would exceed the 256 KiB readable-state limit returns `owner-devices-file-too-large` and leaves the prior state unchanged. |
| Provider rollback | Broker create preflights the complete new record before invoking a provider. If concurrent state growth still makes the final claim fail, broker and direct-provider paths delete the newly created Android AVD, iOS Simulator, or macOS VM; physical attach releases its newly claimed lease. Rollback regressions preserve the concurrent state bytes and verify the provider delete command. |
| Compatibility fencing | Brokers advertise and MCP clients require `owner-device-state-validation-v1`, preventing a current client from reusing a broker that treats malformed state as empty or can write a state file it cannot subsequently read. |
| Focused regression | Type checking and the direct state, admin cleanup, broker lifecycle, broker compatibility, and MCP routing suites passed. The final direct/broker provider-rollback run passed 2 files and 57 tests. |
| Release gates | The full suite passed with 79 files passed, 7 skipped, 1657 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E each passed all 32 steps with zero skips/failures. Build and lint passed, installed-MCP smoke passed all 81 public tools, both production audits reported zero vulnerabilities, the 152-file package dry-run included both source and compiled validators, and `git diff --check` passed. |

## 2026-07-14 Shared Device Ownership State Validation

| Area | Evidence |
| --- | --- |
| Authoritative lock reads | Physical per-hardware lease locks and the Windows Sandbox singleton use a shared bounded reader that does not follow links, requires a regular single-link file, verifies descriptor/path identity, and rejects malformed JSON, invalid records, oversized files, and read races. Only an initially absent path means no owner. |
| Mutation preservation | Direct MCP, host broker, and admin cleanup paths stop before provider or state mutation when authoritative ownership state is invalid. Regressions verify exact malformed bytes and linked targets remain unchanged and that no Windows Sandbox provider command runs. |
| Legacy compatibility | Older valid records may omit later generation, TTL, timestamp, or claim-ID diagnostics. Present fields remain strictly validated, while core owner, resource identity, and provider fields are mandatory. New writes continue to include the complete current schema. |
| Aggregate boundary | `leases.json` is diagnostic rather than ownership authority. A corrupt aggregate is preserved and explicit aggregate reads report a stable error, while a valid per-hardware lock claim remains available and cannot overwrite the corrupt evidence. |
| Compatibility fencing | Brokers advertise and MCP clients require `shared-device-ownership-state-validation-v1`, preventing a current client from reusing a broker that treats a corrupt shared ownership record as unowned. |
| Focused regression | Type checking passed. Physical lease, broker lease/lifecycle, direct Windows Sandbox, broker compatibility, and MCP routing suites passed 7 files and 165 tests; the additional broker malformed-singleton regression passed in the 52-test lifecycle suite. Android boot polling now asserts the deadline-derived timeout range instead of an exact wall-clock millisecond, removing a 4999/5000 ms test flake without weakening the production bound. |
| Release gates | The full suite passed with 79 files passed, 7 skipped, 1662 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E each passed all 32 steps with zero skips/failures. Build and lint passed, installed-MCP smoke passed all 81 public tools, both production audits reported zero vulnerabilities, and the 158-file package dry-run included both source and compiled ownership-state readers. |

## 2026-07-14 Cross-Project CLI Enumeration Fencing

| Area | Evidence |
| --- | --- |
| Public async routing | `ccc devices stop --all-projects` bypasses single-device lifecycle parsing and executes the cross-project cleanup boundary. A regression injects an owner-RPC hook, proves it is never called, and verifies active definitions in two project namespaces become stopped. |
| Fail-closed enumeration | Only an initially absent owner root produces an empty project list. Existing non-directory roots, linked roots or child namespaces, read errors, and root identity changes raise `project-namespace-read-failed`; list, stop, and prune return nonzero instead of reporting false success. |
| Mutation preservation | A linked owner root is rejected before provider or state work. Regressions invoke both cross-project stop and prune and verify the external target's exact device-state bytes remain unchanged. |
| Compatibility scope | This hardening changes only host CLI dispatch and local namespace enumeration. It does not alter broker RPC or MCP semantics and therefore adds no compatibility capability. |
| Focused regression | Type checking and 54 admin, public async CLI, and broker CLI tests passed. Coverage includes canonical and deprecated syntax, initial absence, invalid roots, linked root and child namespaces, stable error output, no owner RPC for cross-project stop, and preserved state. |
| Release gates | The full suite passed with 79 files passed, 7 skipped, 1668 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E each passed all 32 steps, installed-MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 158-file package dry-run included the compiled CLI and bundled MCP server. |

## 2026-07-14 Android Emulator Port Allocation Fencing

| Area | Evidence |
| --- | --- |
| Host-global inventory | Android emulator console ports are discovered across every canonical project namespace. Project enumeration and each Android owner-state read fail closed, so malformed, unreadable, linked, or replaced state cannot be skipped and treated as a free port. The shared project enumerator also preserves the cross-project CLI rule that only an initially absent owner root means an empty set. |
| Conflict behavior | Explicitly requested ports are validated against the same host-global inventory and return `android-emulator-port-conflict` before any provider command or owner-state write. Automatic allocation uses only a fully validated inventory. |
| Cross-process serialization | Inventory selection, optional AVD provider creation, and the final owner-state identity claim execute under `android-emulator-ports.mutation.lock`. A regression holds that file lock externally and proves the broker performs no provider or persistence effect until the lock is released. |
| Compatibility fencing | Brokers advertise and MCP clients require `android-emulator-port-allocation-fencing-v1`, preventing a current client from reusing a broker that can race or skip foreign project state during port allocation. |
| Focused regression | Type checking passed. Admin enumeration, broker lifecycle, broker compatibility, MCP routing, and package tests passed with 6 files and 160 tests. Dedicated cases preserve corrupt foreign state bytes, reject a foreign explicit-port conflict, and prove the global lock covers provider creation and state claim. |
| Release gates | The full suite passed with 79 files passed, 7 skipped, 1671 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E runs passed, installed-MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 160-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Android Direct and Live Port Fencing

| Area | Evidence |
| --- | --- |
| Direct-route parity | Explicit `implicitBroker: false` Android creates use the same canonical all-project state inventory and exact `android-emulator-ports.mutation.lock` contract as broker creates. Portless direct creates persist a deterministic concrete console port and matching `emulator-<port>` serial. |
| Live host inventory | When ADB is available, direct and broker creates merge `adb devices -l` emulator transports into allocation. A failed ADB query returns `android-emulator-live-port-inventory-unavailable` before AVD creation or state mutation; an absent ADB installation preserves metadata-only creation. |
| Start-time fencing | Direct and broker starts reacquire the shared port lock, reread live ADB transports, and return `android-emulator-port-conflict` without spawning the provider when an unmanaged emulator has taken the reserved port since creation. |
| State preservation | Invalid foreign Android state is detected before ADB or provider execution and its exact bytes are preserved. Explicit foreign-project conflicts and external lock contention likewise produce no premature provider or owner-state effects. |
| Compatibility scope | This completes the existing `android-emulator-port-allocation-fencing-v1` contract on the same unreleased branch; no second capability version is needed. Current MCP clients already reject brokers without that capability. |
| Focused regression | Type checking and `git diff --check` passed. Broker lifecycle, direct Android MCP, broker compatibility, and MCP routing suites passed 5 files and 158 tests, including live unmanaged ports, ADB inventory failure, direct all-project corruption, shared-lock serialization, and start-after-create port takeover. |
| Release gates | The full suite passed with 79 files passed, 7 skipped, 1681 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E each passed all 32 steps with zero skips/failures. The suite build and standalone lint passed, installed-MCP smoke passed all 81 public tools, both production audits reported zero vulnerabilities, and the 161-file package dry-run included the direct allocator source and rebuilt bundled MCP server. The personal-path scan and `git diff --check` passed. |

## 2026-07-14 Bounded Control-Plane State

| Area | Evidence |
| --- | --- |
| Bounded owner state | Source and packaged owner-device readers now read at most the configured limit plus one byte from the already validated descriptor. A Linux `/proc/self/status` regression proves a file whose initial `stat.size` is zero cannot bypass the limit. |
| Broker metadata | Host and MCP broker runtime files, owner auth secrets, service ownership, and Appium runtime markers use explicit limits and reject links, hard links, non-files, descriptor/path replacement, malformed JSON, and post-stat growth. MCP runtime and Appium marker writes use atomic replacement, so a final symlink is replaced rather than followed. |
| Lock fencing | Source and packaged shared mutation locks use the same bounded no-follow reader and age the lock path with `lstat`. Host owner-auth provisioning now uses that token-fenced lock. Regressions age linked lock paths independently, recover them, and verify the external target bytes are unchanged. |
| Compatibility scope | This hardening changes local persistence behavior only. It does not alter broker RPC request or response semantics and therefore adds no broker compatibility capability. |
| Focused regression | Type checking and `git diff --check` passed. Shared-lock, owner-state, host broker, MCP broker, and Appium broker suites passed 5 files and 106 tests. |
| Release gates | The full suite passed with 79 files passed, 7 skipped, 1687 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E each passed all 32 steps with zero skips/failures. The suite build and standalone lint passed, installed-MCP smoke passed all 81 public tools, both production audits reported zero vulnerabilities, and the 161-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Windows Sandbox Helper File Boundaries

| Area | Evidence |
| --- | --- |
| Owner-scoped configuration | Broker lifecycle planning accepts a recorded `.wsb` file only below the resolved owner's Windows root. The file and every existing parent are non-linked, the opened descriptor must still identify the same single-link regular file, and the read is capped at 256 KiB. |
| Helper request binding | Responses are capped at 2 MiB and accepted only when both request ID and operation type match the outstanding request. Mismatched and oversized responses remain diagnostic failures rather than becoming tool results. |
| Output confinement | Screenshot, download, and recording results ignore guest-supplied host paths. Only the reported basename under the canonical owner downloads directory is eligible, with non-linked ancestors and a single-link regular output file required. Screenshot reads are additionally capped at 32 MiB. |
| Generated files | Broker and direct-provider helper scripts, request files, and `.wsb` definitions use atomic replacement. Final symbolic links are replaced rather than followed, and linked workspace ancestors stop generation. Minimize markers and diagnostic snippets use bounded no-follow reads. |
| Compatibility scope | This hardening changes local provider-file handling only. It does not alter broker RPC request or response semantics and therefore adds no compatibility capability. |
| Focused regression | Type checking passed. Host-broker lifecycle and Windows MCP suites passed 2 files and 71 tests, including external config rejection, final-link replacement, mismatched and oversized responses, malicious host output paths, bounded screenshots, and minimize-result link/size checks. |
| Release gates | The full suite passed with 79 files passed, 7 skipped, 1687 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E each passed all 32 steps, installed-MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 161-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Windows Sandbox Atomic File Transfers

| Area | Evidence |
| --- | --- |
| Source identity | Upload, download, and recording copies open the source with no-follow semantics, compare descriptor and path identity, require a single-link regular file, and stream from that validated descriptor rather than reopening a checked path. |
| Atomic destination | Copies write a mode-restricted random sibling temporary file and atomically replace the destination only after a complete bounded transfer. A failure removes the temporary file and preserves the prior destination, including when that destination was a symbolic link to an external target. |
| Transfer bounds | Upload staging is limited to 16 MiB. Download and recording output copies are limited to 2 GiB, with the limit enforced while reading so a zero-size or growing source cannot bypass the preflight size check. Tool-level copy failures return bounded MCP errors rather than escaping as server exceptions. A missing or failed recording archive preserves the active recording generation and prior destination for retry; state is cleared only after a verified copy. |
| Workspace hygiene | Upload staging requires a non-linked owner uploads directory and successful helper responses remove the staged host file. Timed-out requests retain their staged input because the guest may still consume the outstanding request. |
| Compatibility scope | This hardening changes local file-transfer behavior only. It does not alter broker RPC request or response semantics and therefore adds no compatibility capability. |
| Focused regression | Type checking and `git diff --check` passed. Shared-state and Windows MCP suites passed 2 files and 22 tests, covering source symbolic and hard links, linked destination replacement, `/proc` post-stat growth, oversized sparse helper output, missing recording output retry, preserved destinations, and upload staging cleanup. |
| Release gates | The full suite passed with 79 files passed, 7 skipped, 1690 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E each passed all 32 steps, installed-MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 161-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Bounded Screenshot Acquisition

| Area | Evidence |
| --- | --- |
| File-backed screenshots | iOS Simulator, macOS VM, and X11 capture into mode-private random temporary directories. A shared reader accepts only a stable single-link regular file, rejects empty output, and caps the read at 32 MiB. Temporary directories are removed in `finally` on success and failure. |
| Android stdout bounds | Emulator and physical-device ADB screenshots use a 30-second command timeout and a 32 MiB `spawnSync` buffer instead of Node's smaller unbounded-duration defaults. A fake ADB regression returns a valid PNG larger than 2 MiB and proves the complete image reaches the MCP response. |
| macOS guest cleanup | VM screenshots use a per-request random remote path, quote it in the guest shell command, and issue a bounded remote removal in `finally`. The downloaded host temporary file is likewise removed before the tool returns. |
| Adversarial coverage | Shared screenshot-reader tests reject missing, empty, symbolic-link, hard-link, and sparse oversized files. iOS and macOS provider tests extract the generated host path from their command logs and prove it no longer exists after the call. |
| Compatibility scope | This hardening preserves the existing PNG MCP response shape and provider routing. It changes only local acquisition bounds, temporary-file lifetime, and provider command deadlines, so no broker compatibility capability is required. |
| Focused regression | Command-path, screenshot-boundary, Android emulator, iOS Simulator, and macOS VM suites passed 5 files and 28 tests. Follow-up iOS/macOS cleanup regressions passed 2 files and 5 tests. |
| Release gates | The full suite passed with 80 files passed, 7 skipped, 1692 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 162-file package dry-run included the source and bundled screenshot hardening. The personal-path scan and `git diff --check` passed. |

## 2026-07-14 Atomic Cross-Provider File Transfers

| Area | Evidence |
| --- | --- |
| Upload snapshots | Android emulator/device, iOS Simulator, and macOS VM uploads copy the selected host file from a stable single-link descriptor into a private 16 MiB-bounded staging file. Secret-content scanning runs against that immutable snapshot before any provider receives it. |
| Download commits | ADB and SCP download into private staging. iOS app-container reads are copied into the same bounded staging contract. Successful results are capped at 2 GiB and atomically replace the validated host destination; provider failure, missing output, links, and oversized files preserve the previous destination. |
| Provider deadlines | Android ADB push and pull use a finite five-minute command timeout. macOS transfers retain the existing bounded helper timeout, while iOS local app-container copies use bounded descriptor streaming. |
| Workspace hygiene | Upload and download staging directories are removed on provider success, provider failure, validation failure, and commit failure. Cleanup failure is best effort and cannot replace the actual MCP operation result. |
| Compatibility scope | Public tool names, arguments, result fields, original local paths, and provider labels are unchanged. Only provider-facing local paths are replaced with private staged paths, so no broker compatibility capability is required. Recording-stop artifact/state handling is covered separately below. |
| Focused regression | Transfer-boundary, Android emulator/device, iOS Simulator, and macOS VM suites passed 5 files and 25 tests. Coverage proves upload snapshot independence, staged secret and hard-link rejection, destination preservation, replaced-link rejection, failed ADB pull preservation, and success/failure staging cleanup. |
| Release gates | The full suite passed with 81 files passed, 7 skipped, 1696 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run included the source and bundled transfer module. |

## 2026-07-14 Atomic Recording Finalization

| Area | Evidence |
| --- | --- |
| Durable finalization | Android emulator/device and macOS VM recorder exits transition to an inactive finalization-pending generation instead of deleting state. Failed ADB/SCP transfer or local commit preserves that generation and the remote artifact, allowing `device_record_video_stop` to retry without starting another recorder. |
| Atomic host artifacts | Android and macOS copy provider output into private bounded staging before a non-empty recording atomically replaces the requested host destination. iOS Simulator records into an owner-scoped private staging directory and commits only after the recorder exits. Provider failure, empty output, destination-policy failure, and commit failure preserve the previous destination. |
| Generation fencing | Each stop claims a fresh finalization runtime generation before reading or committing the artifact. A stale monitor or stop cannot clear or publish over a successor generation. State is cleared and remote/staged artifacts are removed only after a successful host commit by the claimed generation. |
| Lifecycle cleanup | iOS device stop discards only a structurally validated recording stage below the current owner/device recording root. Immediate startup failure and successful finalization also remove their private stage. Delete and Simulator erase refuse active or pending recordings by default; explicit forced deletion safely stops an owned recorder before discarding its validated stage. Legacy in-flight iOS recordings without staging metadata are migrated by bounded-copying the prior direct output through a new atomic stage. |
| Retry coverage | Fake Android emulator and physical-device ADB, iOS Simulator, and macOS SCP tests force first-attempt transfer or commit failure, verify the old destination bytes and pending state, then retry and verify the final artifact and cleared state. Natural recorder exit, empty iOS output, persistent-stage cleanup, forced-delete cleanup, erase/delete refusal, and legacy iOS state are covered. |
| Compatibility scope | Public tool names, arguments, provider labels, and successful response structure remain compatible. Pending recordings are now observable as `recording.active: false` until finalized, replacing the previous data-losing behavior that silently cleared recoverable artifacts. No broker RPC capability change is required. |
| Focused regression | Runtime-generation, transfer-boundary, Android emulator/device, iOS Simulator, and macOS VM suites passed 6 files and 31 tests. |
| Release gates | The full suite passed with 81 files passed, 7 skipped, 1698 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run included the updated source and bundled MCP server. |

## 2026-07-14 Bounded Direct Provider Commands

| Area | Evidence |
| --- | --- |
| Execution deadlines | The shared direct-provider command runner now gives every text and binary child process a finite two-minute default deadline. Explicit deadlines are normalized to at least one millisecond and capped at ten minutes, preventing fractional values from becoming Node's timeout-disabling zero. AVD creation and iOS app installation retain explicit five-minute operational budgets. |
| Output bounds | Text and binary provider commands have an 8 MiB default output budget and a hard 64 MiB configurable ceiling. Output overflow terminates the child instead of allowing provider output to grow with process memory. Existing 32 MiB screenshot capture remains within the hard ceiling. |
| Discovery safety | `where` and POSIX `command -v` probes have a five-second deadline and 1 MiB output budget. Discovery accepts only executable-name syntax beginning with an alphanumeric character, so shell syntax is rejected before spawning. |
| Windows provisioning input | Executed Android AVD names, system-image package identifiers, and device-profile identifiers are validated against Android SDK identifier syntax and bounded lengths before a Windows batch command is constructed. Metadata-only definitions remain compatible because no provider command is executed. |
| Adversarial coverage | Real child-process tests prove deadline expiry returns `ETIMEDOUT` and output overflow returns `ENOBUFS`. Mocked execution tests cover defaults, maximum clamps, fractional minimum clamps, discovery bounds, and shell-syntax rejection. Fake Android MCP coverage proves `%PATH%`-style AVD, image, and profile inputs are rejected without reaching `avdmanager`. |
| Compatibility scope | Public tools and successful result shapes are unchanged. Commands that previously could hang forever or expand unsafe Windows provider arguments now fail with bounded provider diagnostics. No broker RPC capability change is required. |
| Focused regression | Command execution/path and affected Android/iOS provider suites passed 5 files and 32 tests. A final command-only rerun passed 2 files and 12 tests, and `git diff --check` passed. |
| Release gates | The full suite passed with 82 files passed, 7 skipped, 1702 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run included the updated provider sources and bundled MCP server. |

## 2026-07-14 Bounded Public Device Timeouts

| Area | Evidence |
| --- | --- |
| Public timeout contract | Every public `helperTimeoutMs` input now has a one-millisecond minimum and five-minute maximum. Mobile wait and device boot operations have a ten-minute maximum, while wait polling intervals are capped at one minute. |
| MCP routing deadline | Device-tool HTTP deadlines are normalized even when schema validation is bypassed. Helper calls can reserve at most 330 seconds including the outer diagnostic buffer, and bounded wait calls at most 630 seconds. Explicit RPC deadlines are subject to the same outer ceiling. |
| Broker child deadline | The host broker independently caps helper child execution at 315 seconds and bounded waits at 615 seconds, including its 15-second termination buffer. Irrelevant `timeoutMs` values do not extend non-wait tools. |
| Direct helper deadline | Direct Windows Sandbox helper polling independently normalizes invalid values to 30 seconds and caps explicit values at 300 seconds. Fractional positive values cannot truncate to the timeout-disabling zero value. |
| Test build determinism | `npm test` now builds distribution artifacts exactly once before Vitest starts and marks Docker E2E to reuse that build. This removes the observed race where package contract tests could launch a stale bundled MCP while another worker rewrote `dist`. Watch mode remains build-free. |
| Adversarial coverage | Cross-layer tests pass maximum-safe integers, invalid negatives, irrelevant timeout fields, and schema-bypass values through the public schema, MCP router, broker child calculator, and direct Windows helper normalizer. Focused provider, routing, broker, and schema suites passed 5 files and 87 tests. |
| Release gates | After the deterministic prebuild change, the full suite passed on its first run with 83 files passed, 7 skipped, 1706 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, lint passed, both production audits reported zero vulnerabilities, and the package dry-run contained 163 files. |

## 2026-07-14 Bounded Diagnostic Responses

| Area | Evidence |
| --- | --- |
| MCP error bounds | Explicit MCP text failures are capped at 64 KiB by UTF-8 byte length, including multibyte input. Successful text and short failures preserve their prior values. |
| Structured failures | Oversized semantic JSON failures remain valid JSON and retain bounded top-level identity fields such as error, owner, method, backend, device, tool, route, and status. The summary records the original and maximum byte counts without echoing unbounded nested diagnostics. |
| Broker HTTP containment | Non-success broker HTTP payloads are capped at 256 KiB. Oversized failures become structured summaries, while circular or otherwise unserializable payloads produce a bounded HTTP 500 diagnostic instead of escaping the request handler. Successful serializable payloads remain unchanged. |
| Compatibility contract | Host and MCP compatibility checks now require `bounded-error-responses-v1`. A reachable older broker is treated as incompatible and replaced rather than silently bypassing the response bound. Fake compatible brokers explicitly advertise the same contract. |
| Adversarial coverage | Tests cover multibyte expansion, tiny and zero truncation budgets, oversized nested failures, circular broker payloads, unchanged success values, and stale-broker capability detection. Focused broker, MCP routing, and response suites passed 4 files and 96 tests. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1711 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, lint passed, both production audits reported zero vulnerabilities, and the package dry-run contained 163 files. |

## 2026-07-14 Physical Lease Directory Fencing

| Area | Evidence |
| --- | --- |
| Directory integrity | Broker and direct-provider lease operations validate the shared state root, physical-lease root, backend directory, and lock directory as real non-symbolic-link directories before reads, writes, or mutation-lock acquisition. Linked or non-directory components fail without mutating an external target. |
| Bounded enumeration | The broker streams lease directory entries and stops after 1,024 total entries. An oversized directory returns a structured HTTP 507 `physical-lease-directory-entry-limit-exceeded` failure instead of allocating or scanning an unbounded list. |
| Filename isolation | Malformed URI encodings and non-canonical encoded lease filenames are ignored. They cannot break listing or pruning of valid canonical lease records. |
| Operation coverage | The checks cover broker list, prune, claim, heartbeat, release, physical inventory, and detach paths, plus the direct physical-device lease store used outside broker routing. Existing successful lease response shapes remain unchanged. |
| Compatibility contract | Host and MCP compatibility checks now require `physical-lease-directory-fencing-v1`. A reachable older broker is treated as incompatible and replaced rather than silently retaining the unfenced shared-state behavior. |
| Adversarial coverage | Regressions cover linked lock and aggregate directories, external-target preservation, malformed and alias filenames, and directories beyond the entry limit. The focused lease, broker, routing, compatibility, and runner suites passed before the full release gate. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1715 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, installed-MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Owner Auth Directory Fencing

| Area | Evidence |
| --- | --- |
| Host authority | Owner-secret reads and provisioning validate the device state root, broker directory, and auth directory as real non-symbolic-link directories before opening a secret, acquiring its mutation lock, quarantining invalid metadata, or writing a replacement. A linked auth directory fails closed without creating, moving, or deleting files in its target. |
| MCP authentication | The MCP client applies the same parent-directory validation before reading the broker-owned owner secret. A valid-looking secret below a linked directory is ignored and no authenticated RPC is issued. |
| Bounded recovery | Abandoned auth artifact cleanup streams directory entries and examines at most 1,024 entries per provisioning attempt. Cleanup remains best effort and cannot turn an oversized directory into unbounded allocation or delay secret creation indefinitely. |
| Compatibility contract | Host and MCP compatibility checks now require `owner-auth-directory-fencing-v1`. A reachable older broker is treated as incompatible instead of reusing an authority that can traverse a substituted auth directory. |
| Adversarial coverage | Host tests prove linked auth-directory rejection and external-target preservation. MCP tests prove a matching external secret is not trusted and no owner RPC is sent. Existing invalid, oversized, linked, hard-linked, concurrent, and stale-lock secret recovery tests continue to pass. Focused broker, MCP, routing, lease, and command suites passed 5 files and 159 tests. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1717 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, the bundled MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run and `git diff --check` passed. |

## 2026-07-14 Appium Runtime Installation Fencing

| Area | Evidence |
| --- | --- |
| Packaged input boundary | The broker reads Appium `package.json` and `package-lock.json` through stable no-follow single-link descriptors, caps them at 64 KiB and 8 MiB, validates both as JSON objects, and hashes the exact bounded snapshots used for installation. Missing manifests remain distinct from linked, hard-linked, malformed, oversized, or unreadable manifests. |
| Runtime directory boundary | The device state root, broker directory, and shared Appium runtime must be real non-symbolic-link directories before marker reuse, package writes, lock acquisition, or launch. An existing `node_modules` must also be a real directory before npm runs. Runtime manifests are atomically replaced, so linked destination files cannot redirect writes to external targets. |
| Executable identity | A matching runtime marker is insufficient by itself. The actual `node_modules/appium/index.js` launch entry must be a bounded single-link regular file reached through real directories, and the broker repeats that validation before launching Node. Linked or hard-linked entries are reinstalled or rejected rather than executed. |
| Installation serialization | A broker-global token-fenced mutation lock covers marker inspection, manifest replacement, `npm ci`, installed-entry validation, and marker commit. Its wait budget includes the five-minute npm deadline, stale ownership is process-aware, and a live competing lock produces `appium-runtime-install-lock-timeout` without running npm or Appium. |
| Compatibility contract | Host and MCP compatibility checks require `appium-runtime-installation-fencing-v1`, preventing a current MCP client from silently reusing an older broker that lacks these installation boundaries. |
| Adversarial coverage | Broker tests cover linked and hard-linked packaged manifests, oversized lockfiles, linked runtime and `node_modules` directories, a matching marker with a linked entry, a live competing install lock, atomic replacement of linked runtime manifests, and external-target preservation. Focused Appium and host/MCP compatibility suites passed 4 files and 128 tests. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1,723 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Bounded Appium HTTP Transport

| Area | Evidence |
| --- | --- |
| Redirect boundary | Every broker-to-Appium fetch uses manual redirect handling. Any 3xx response is rejected as `appium-redirect-disallowed`; the broker never contacts the supplied `Location`, preventing a loopback Appium process from turning the broker into an HTTP redirect proxy. |
| Response bound | Appium response bodies are read incrementally with a 16 MiB ceiling. Oversized `Content-Length` values are rejected before accumulation, and chunked or decoded bodies are stopped as soon as actual bytes exceed the same ceiling. |
| Operation coverage | Status readiness, session create/reuse/delete, generation-conflict rollback, and public allowlisted WebDriver requests all use the same bounded no-redirect transport helper. Existing short JSON and bounded non-JSON diagnostics preserve their public shapes. |
| Compatibility contract | Host and MCP compatibility checks require `bounded-no-redirect-appium-http-transport-v1`, so a current client will not silently reuse an older broker lacking these transport guarantees. |
| Adversarial coverage | A redirect regression uses separate Appium and target servers and proves the target receives zero requests. A chunked response without `Content-Length` exceeds the stream ceiling and returns a bounded `appium-response-too-large` diagnostic. Focused Appium and host/MCP compatibility suites passed 4 files and 130 tests. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1,725 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run and personal-path scan passed. |

## 2026-07-14 Bounded MCP Broker HTTP Transport

| Area | Evidence |
| --- | --- |
| Control-plane bound | Broker health, capability status, and owner resolution read decoded response streams incrementally with a 1 MiB ceiling. An oversized declared length is rejected before accumulation, while chunked growth is stopped at the same actual-byte boundary. |
| RPC bound | Authenticated broker RPC responses use the same reader with a 64 MiB ceiling, retaining room for bounded screenshot/base64 results while preventing an impersonating or compromised local broker from consuming unbounded MCP memory. |
| Redirect and format policy | All four MCP broker fetch sites use manual redirects. A 3xx response returns `broker-redirect-disallowed` without contacting `Location`; accepted responses must parse as non-array JSON objects, so empty, scalar, array, or malformed HTTP 200 bodies cannot become broker availability or successful RPC results. Invalid raw diagnostics are capped at 32 KiB. |
| Adversarial coverage | Separate redirect source and target servers prove health probing never contacts the target. A chunked owner-resolve response exceeds the control ceiling, and an authenticated RPC with an oversized declared length fails before body accumulation. The dedicated MCP broker suite passed 34 tests; the focused MCP routing and host compatibility group passed 3 files and 97 tests. |
| Compatibility scope | The guarantee is enforced by the current MCP client before it trusts any host response. It does not depend on broker cooperation and therefore intentionally adds no host capability requirement. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1,728 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, build, MJS syntax validation, and lint passed. Both production audits reported zero vulnerabilities, and the 163-file package dry-run and personal-path scan passed. |

## 2026-07-14 Bounded Host CLI Broker HTTP Transport

| Area | Evidence |
| --- | --- |
| Host control plane | Host CLI health, compatibility status, and owner-resolution probes share a streaming JSON reader with a 1 MiB ceiling. Oversized declared lengths fail before accumulation and chunked bodies stop at the actual-byte boundary. |
| Owner RPC | Public `ccc devices` owner RPC reads at most 64 MiB, preserving bounded screenshot payload support without allowing a local port impersonator or compromised broker to consume unbounded host CLI memory. |
| Redirect and format policy | All four host CLI broker requests use manual redirect handling and reject 3xx responses as `broker-redirect-disallowed`. Empty, malformed, scalar, and array bodies are not accepted as broker protocol objects; invalid raw diagnostics remain capped at 32 KiB. |
| Adversarial coverage | A health redirect regression proves the target receives zero requests, an authenticated RPC redirect does the same, a declared oversized RPC body fails before accumulation, and a chunked control response is stopped above 1 MiB. Multibyte malformed responses prove both host CLI and MCP raw diagnostics stay within the exact 32 KiB byte ceiling. Focused host broker, public CLI, and MCP broker suites passed 3 files and 99 tests. |
| Compatibility scope | The current host CLI enforces this boundary before trusting a response, so no new host broker capability is required. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1,734 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Bounded Direct iOS Appium Transport

| Area | Evidence |
| --- | --- |
| Shared provider boundary | iOS Simulator and iOS physical-device direct providers import the same XCUITest HTTP client. Every status, session lifecycle, source, screenshot, action, and active-app request now crosses one bounded transport. |
| Response and redirect policy | Direct Appium responses stream with a 16 MiB ceiling, oversized declared lengths fail before accumulation, chunked growth stops at the same actual-byte boundary, and all redirects are rejected without contacting `Location`. |
| Deadline and diagnostics | Explicit HTTP deadlines are capped at five minutes. Malformed successful responses retain the existing `{ raw }` compatibility shape, while malformed HTTP failures retain the existing error form; both raw and full failure messages stay within an exact 32 KiB UTF-8 ceiling. |
| Adversarial coverage | Separate redirect source and target servers prove no target request, declared and chunked oversized responses fail, multibyte malformed success/failure diagnostics remain bounded, and timeout normalization rejects unbounded values. Simulator, physical-device, and broker-Appium compatibility suites passed 3 files and 20 tests. |
| Compatibility scope | This protection ships inside the current direct provider implementation and requires no broker capability change. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1,739 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Broker Autostart Log Fencing

| Area | Evidence |
| --- | --- |
| Directory boundary | Host CLI and MCP-owned broker launch paths validate the device state root, broker directory, and logs directory as real non-symbolic-link directories before creating a log or spawning a child. A linked logs directory fails before launch without writing into its external target. |
| Log-file identity | Launch logs use random names and exclusive no-follow creation. The opened descriptor must remain a single-link regular file matching the path device/inode before it is handed to the broker child, and mode 0600 is applied where supported. Existing files are never append-opened. |
| Bounded diagnostics | MCP launch failure diagnostics open the log no-follow, repeat descriptor/path identity checks, and read only its final 4 KiB. A large broker log is never loaded in full, and a linked final log file is ignored. |
| Adversarial coverage | Host and MCP tests replace the logs directory with a link and prove no broker command is spawned and the external marker remains unchanged. Additional tests verify random single-link host logs, a bounded tail from a 2 MiB file, and rejection of linked or out-of-directory log files. Focused broker and routing suites passed 4 files and 132 tests. |
| Compatibility scope | Log safety is enforced by whichever current host CLI or MCP client launches the broker, so no broker capability change is required. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1,743 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, build, MJS syntax validation, and lint passed. Both production audits reported zero vulnerabilities, and the 163-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Windows Provider Launcher Path Fencing

| Area | Evidence |
| --- | --- |
| Directory boundary | Hidden Node preload and VBS launcher creation validates the device state root and every launcher parent as real non-symbolic-link directories. Provider directory names are limited to a single conservative path segment. |
| File identity | Both launcher types use 128-bit random names and exclusive no-follow mode-0600 creation. Content is written through the opened descriptor, and the resulting path must still identify the same single-link regular file with the exact expected size before launch. |
| Lifecycle | The process-scoped preload is reused only while bounded no-follow reads prove its content and path remain valid. Each VBS wrapper receives a unique file; cleanup runs when the wrapper closes and has a 60-second unrefed fallback, while failed spawns remove the launcher immediately. |
| Compatibility contract | Host CLI and MCP compatibility checks require `windows-provider-launcher-path-fencing-v1`, preventing current clients from reusing brokers that still write predictable launcher paths through substituted directories or files. |
| Adversarial coverage | Tests prove linked preload and VBS directories fail before file creation while preserving external markers, generated files have random names and one link, preload reuse verifies content, and traversal-like provider names are rejected. Focused command, Appium, host broker, MCP broker, and routing suites passed 5 files and 203 tests. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1,748 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Clipboard Server Orphan Recovery

| Area | Evidence |
| --- | --- |
| Failure mode | Repeated self-contained real-test runner subprocesses could detach `clipboard-server.js --serve` and then exit without normal session cleanup. The old server waited up to 30 minutes, allowing workers to accumulate until Node module loads failed with OS `ENOMEM`. |
| Session-aware recovery | The detached server checks PID-validated CCC session locks every five seconds. No live session starts a 15-second grace period; a live session resets it, and expiration runs the existing graceful shutdown and state cleanup path. |
| Test stability | The strict MCP coverage subprocess test now declares the same 60-second budget used by adjacent self-contained runner cases instead of relying on Vitest's 30-second default under parallel load. |
| Verification | Pure watchdog tests cover grace start, pre-deadline survival, deadline expiry, and active-session reset. A built-server process test with an isolated HOME and no lock exited cleanly with status 0 after 19 seconds. After the full suite completed, a 22-second post-run check found no surviving workspace clipboard server. |
| Release gates | The full suite passed with 84 files passed, 7 skipped, 1,748 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, build and lint passed, both production audits reported zero vulnerabilities, and the 163-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Direct Android Windows Launcher Fencing

| Area | Evidence |
| --- | --- |
| Direct-provider boundary | The Android direct provider no longer overwrites a predictable `ccc-android-emulator-launcher.vbs`. Every emulator start on Windows receives a private 128-bit random launcher. |
| Directory and identity checks | The host home, `.ccc`, device-state, owner, backend, device, and tools directories are created one segment at a time and must remain real non-symbolic-link directories. Device IDs are restricted to a conservative single path segment. Launchers use exclusive no-follow mode-0600 creation, complete descriptor writes, and descriptor/path single-link identity and exact-size checks. |
| Lifecycle | A launcher is removed when the `wscript.exe` wrapper closes, after a bounded 60-second unrefed fallback, or immediately when spawn throws. Concurrent starts never share or overwrite a launcher. |
| Adversarial coverage | Tests prove two launches receive distinct exact-content single-link files, an exclusive-name collision preserves the existing file, a linked `.ccc` parent fails without touching its external marker, traversal-like device IDs fail before directory creation, and both close and fallback cleanup remove their files. The focused launcher and Android lifecycle suites passed 2 files and 18 tests. |
| Test-runner stability | The normal Vitest suite uses half the available CPUs with a hard ceiling of eight workers. MCP subprocess fixtures therefore retain their existing strict deadlines without a 16-core host starting sixteen process-heavy test files concurrently; Level 3 keeps its separate serial provider configuration. |
| Compatibility scope | This protection is part of the current direct provider and does not alter broker RPC semantics, so it intentionally requires no additional broker capability. |
| Release gates | With the bounded worker pool, the full suite passed with 85 files passed, 7 skipped, 1,753 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, build, MJS syntax validation, and lint passed. Both production audits reported zero vulnerabilities, and the 163-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Direct macOS Executable Artifact Fencing

| Area | Evidence |
| --- | --- |
| Workspace boundary | Direct macOS VM paths validate owner and device IDs as conservative single segments. The host home and every workspace, tools, and recordings directory component must be a real non-symbolic-link directory before executable materialization. |
| Atomic executable installation | SSH askpass and guest-helper scripts are written through exclusive no-follow mode-0700 descriptors to random sibling files. Complete writes, exact size, one link, and descriptor/path identity are verified before an atomic rename; the installed path is verified against the same inode afterward. |
| Link and collision behavior | A final script symlink is replaced rather than followed, preserving its external target. A linked workspace parent fails before external mutation, traversal-like device IDs fail before directory creation, and a colliding temporary file is never removed or overwritten. |
| Secret handling | The askpass artifact contains only an environment-variable reference. The SSH password remains in the child environment and is not persisted in the script. |
| Compatibility scope | These guarantees ship in the direct macOS provider and do not alter broker RPC behavior, so no new broker capability is required. |
| Adversarial coverage | Dedicated artifact regressions and the existing fake-Tart lifecycle and desktop/video suites passed 3 files and 9 tests. |
| Release gates | The full suite passed with 86 files passed, 7 skipped, 1,758 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, the current bundled MCP smoke passed all 81 public tools, build, MJS syntax validation, and lint passed. Both production audits reported zero vulnerabilities, and the 163-file package dry-run, personal-path scan, and `git diff --check` passed. |

## 2026-07-14 Canonical Owner Device IDs

| Area | Evidence |
| --- | --- |
| Persisted-state boundary | Host CLI and MCP owner-state readers reject missing, empty, duplicate, dot-segment, traversal, absolute, backslash-containing, non-ASCII, and over-128-byte device IDs before returning any device record. Mutations preserve the original invalid state instead of replacing it. |
| Provider isolation | A canonical ID is a single conservative path segment, so Android, iOS, Windows, and macOS provider workspace construction cannot escape an owner namespace through a corrupted or caller-supplied record ID. Existing generated IDs already satisfy the contract. |
| Public contract | All 66 advertised `deviceId` properties carry the same minimum, maximum, and pattern constraints. Central runtime dispatch applies the same validation before direct, broker, physical, or nested flow routing and emits a bounded `device-id-invalid` diagnostic rather than an unexpected provider error. |
| Compatibility fencing | Host brokers advertise and MCP clients require `canonical-owner-device-ids-v1`. A reachable older broker is treated as incompatible instead of being reused with a weaker persisted-state boundary. |
| Adversarial coverage | State tests exercise missing IDs, POSIX and Windows traversal, absolute paths, dot segments, non-ASCII text, oversize, duplicate, symbolic-link, and hard-link cases against both host and MCP readers. Live stdio MCP tests prove direct create/status and nested flow calls reject unsafe IDs before routing. Focused state, schema, and foundation suites passed 3 files and 32 tests. |
| Release gates | The full suite passed with 86 files passed, 7 skipped, 1,767 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, and build, lint, and `git diff --check` passed. Both production audits reported zero vulnerabilities, and the package dry-run contained 163 files. |

## 2026-07-14 iOS Simulator Owner Identity Fencing

| Area | Evidence |
| --- | --- |
| Persisted identity boundary | Direct MCP and host-broker routes no longer treat an owner-prefixed recorded name plus an arbitrary UDID as authority. Before a host effect, `simctl list devices -j` must resolve the recorded UDID to exactly one Simulator whose live name exactly matches the current owner's recorded simulator name. |
| Covered operations | The verified host UDID is used for direct lifecycle, execution, screenshot, transfer, reset, application, privacy, location, clipboard, wait, recording, and Appium work. Host-broker lifecycle, recording, owner cleanup, and Appium session creation or reuse apply the same check before provider or HTTP effects. |
| Compatibility fencing | Host brokers advertise and MCP clients require `ios-simulator-owner-identity-fencing-v1`, preventing reuse of a reachable broker that still trusts persisted Simulator identifiers without live inventory verification. |
| Adversarial coverage | Direct and broker tests persist an owner-prefixed alias pointing at a foreign host UDID and prove lifecycle, execution, screenshot, Appium, deletion, and recording fail before any command or session reuse targets that foreign Simulator. Focused iOS, broker lifecycle, Appium, and MCP routing suites passed 7 files and 222 tests. |
| Test stability | The macOS desktop-video fixture now uses a 30-second recording limit. This preserves its active-recording assertion under full-suite process load instead of allowing the former 3-second fake recording to expire before status inspection. |
| Release gates | The full suite passed with 86 files passed, 7 skipped, 1,769 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, and build, TypeScript, lint, MJS syntax, and `git diff --check` passed. Both production audits reported zero vulnerabilities, the package dry-run contained 163 files, and the personal-path scan passed. |

## 2026-07-14 Physical Appium Lease Fencing

| Area | Evidence |
| --- | --- |
| Direct iOS boundary | Every mutating physical-iOS operation refreshes the exact lease using the persisted device ID, UDID, claim ID, and per-operation claim nonce. Appium session reuse and creation repeat the check before any process or HTTP effect. |
| Host-broker boundary | Physical Android and iOS Appium session ensure, session delete, and WebDriver request RPCs require a non-expired lease whose owner, device ID, claim ID, and claim nonce all match the persisted attachment. |
| Failure behavior | Missing metadata, absent or expired leases, foreign owners, and forged claims return `physical-device-not-attached` or a bounded direct-provider lease diagnostic before provider commands or Appium requests. Input validation still precedes authority checks. |
| Compatibility fencing | Host brokers advertise and MCP clients require `physical-appium-lease-fencing-v1`, preventing a same-version stale broker from retaining the weaker persisted-UDID/serial trust boundary. |
| Adversarial coverage | Direct iOS tests replace a valid lease with a foreign record and prove lifecycle and install effects do not run. Broker tests prove session ensure, deletion, and requests cannot use a forged physical record without its exact lease. |
| Release gates | The full suite passed with 86 files passed, 7 skipped, 1,771 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed all 64 steps with zero skips/failures, bundled MCP smoke passed all 81 public tools, and build, TypeScript, lint, MJS syntax, and `git diff --check` passed. Both production audits reported zero vulnerabilities, and the package dry-run contained 163 files. |

## 2026-07-14 Direct Android Physical Lease Authority

| Area | Evidence |
| --- | --- |
| Exact attachment boundary | Direct Android physical-device status, ADB-backed effects, lifecycle, and detach handling refresh the persisted lease using owner ID, device ID, hardware serial, claim ID, claim nonce, and expiry before touching the target. |
| Failure behavior | Missing metadata, absent or expired leases, foreign owners, and forged claims fail before ADB discovery or target commands, volatile-process signaling, or attachment removal. A stale owner record cannot act as authority over a newly leased physical device. |
| Adversarial coverage | A direct MCP regression creates a valid attachment, forges its claim nonce, and proves status, execution, lifecycle, and detach all fail without emitting an `adb -s <serial>` command. The original exact lease is restored only for deterministic cleanup. Focused direct-provider and lease suites passed 5 files and 38 tests. |
| Compatibility | This is a direct-provider invariant and does not change the broker protocol. Physical Android Appium routes already require `physical-appium-lease-fencing-v1`. |
| Full-suite observation | The first full run exposed one unrelated, non-reproducible macOS fake-recorder early-exit assertion. The test passed in isolation and the complete suite then passed unchanged on rerun; this remains recorded as a fixture stability observation rather than being hidden as a clean first attempt. |
| Release gates | The full suite passed with 86 files passed, 7 skipped, 1,772 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed, bundled MCP smoke passed all 81 public tools, and build, TypeScript, lint, MJS syntax, and `git diff --check` passed. Both production audits reported zero vulnerabilities, the package dry-run contained 163 files, and the personal-path scan passed. |

## 2026-07-14 Host-Broker Physical Device-Tool Lease Fencing

| Area | Evidence |
| --- | --- |
| Broker authority boundary | Physical Android and iOS backend-tool dispatch refreshes the exact lease before invoking any runner. Broker-managed Android physical recording start and stop apply the same guard before ADB commands, process signals, artifact pulls, or state transitions. Physical Appium session and request paths now refresh through the shared guard as well. |
| Time-of-check defense | The host broker validates owner, device, serial or UDID, claim ID, claim nonce, and expiry under the physical lease mutation lock. Current direct providers independently repeat the exact check immediately before target effects, closing the broker-to-child dispatch interval. |
| Failure behavior | Missing metadata, expired leases, foreign owners, and successor claim nonces return bounded `physical-device-not-attached` diagnostics. The underlying lease failure is reported without exposing the successor lease record. |
| Compatibility fencing | Brokers advertise and MCP clients require `physical-device-tool-lease-fencing-v1`, so a current MCP cannot reuse a same-version broker whose bundled physical provider or recording route lacks this boundary. |
| Adversarial coverage | A valid lease proves heartbeat and runner dispatch. Replacing its nonce then proves backend execution and recording start/stop cannot invoke the runner, ADB command runner, or process signal. Existing Android and iOS child-handler fixtures now model exact leases. Focused broker contract, routing, Appium, and command suites passed 5 files and 207 tests. |
| Release gates | The full suite passed with one worker in the long-lived container: 86 files passed, 7 skipped, 1,773 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed, bundled MCP smoke passed all 81 public tools, and the suite build, TypeScript, lint, MJS syntax, and `git diff --check` passed. Both production audits reported zero vulnerabilities, and the package dry-run contained 163 files. The preceding parallel run accumulated unrelated timeout and `EADDRINUSE` failures while this container already held 1,610 defunct Node children under a non-reaping `tail` PID 1; the serial rerun isolates that environment pressure from this slice's behavior. |

## 2026-07-14 Host-Broker Physical Lifecycle Use-Time Lease Refresh

| Area | Evidence |
| --- | --- |
| Remaining gap | Explicit `broker.command.invoke` status and start operations planned a physical provider command from owner state, but only start performed a read-only lease comparison. Neither path refreshed the exact claim under the lease mutation lock immediately before ADB or devicectl execution. |
| Execution boundary | Non-dry-run physical status and start now heartbeat the persisted owner, device ID, serial or UDID, claim ID, and claim nonce after planning and before provider dispatch. Stop/delete retain the separate exact release guard and rollback path. |
| Failure behavior | Missing metadata, expiration, foreign ownership, and successor claims return bounded `physical-device-not-attached` diagnostics without invoking the command runner. Dry-run command planning remains non-mutating. |
| Compatibility fencing | Brokers advertise and MCP clients require `physical-lifecycle-use-lease-refresh-v1`. This is intentionally distinct from the earlier `physical-lifecycle-lease-fencing-v1` release/rollback contract, preventing a current client from reusing a broker that only fences teardown. |
| Adversarial coverage | A valid Android physical lifecycle status invocation proves heartbeat and provider execution. Replacing the lease nonce then proves both status and start fail before another provider command. Broker command, status, MCP compatibility, and routing suites passed 4 files and 169 tests. |
| Release gates | The single-worker full suite passed with 86 files passed, 7 skipped, 1,773 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed, bundled MCP smoke passed all 81 public tools, and the suite build, TypeScript, lint, MJS syntax, and `git diff --check` passed. Both production audits reported zero vulnerabilities, and the package dry-run contained 163 files. |

## 2026-07-14 Live Appium Runtime Metadata Fencing

| Area | Evidence |
| --- | --- |
| Failure mode | `broker.appium.record` and `broker.appium.clear` could overwrite or erase metadata for a live broker-owned Appium server without stopping it. The process remained alive while its owner-scoped cleanup authority and runtime generation were lost. |
| Live-runtime boundary | Record and clear inspect broker ownership, PID, and process identity under the owner/device operation lock. A matching live runtime returns bounded `appium-runtime-active` and directs the caller to stop the server first. No signal is sent by metadata-only operations. |
| Recovery behavior | Imported metadata and broker runtime records whose process exited or whose identity no longer matches remain replaceable and clearable. Successful updates use the existing generation-matched Appium transition rather than unconditional record replacement. |
| Compatibility fencing | Brokers advertise and MCP clients require `appium-live-runtime-metadata-fencing-v1`, preventing reuse of a broker that can orphan a managed Appium process through metadata APIs. |
| Adversarial coverage | A current-process identity fixture proves both record and clear preserve a live runtime, then changes the PID and proves stale metadata can still be cleared. Appium, broker status, MCP compatibility, and routing suites passed 4 files and 144 tests. |
| Release gates | The single-worker full suite passed with 86 files passed, 7 skipped, 1,774 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed, bundled MCP smoke passed all 81 public tools, and the suite build, TypeScript, lint, and MJS syntax checks passed. Both production audits reported zero vulnerabilities, and the package dry-run contained 163 files. |

## 2026-07-14 Direct Admin Runtime Cleanup Fencing

| Area | Evidence |
| --- | --- |
| Failure mode | Synchronous owner cleanup and compatibility CLI stop/delete paths performed provider effects from an old snapshot, then cleaned or removed the current same-ID record unconditionally. A concurrent runtime generation could lose Appium, recording, or lifecycle authority after the old operation completed. Direct cleanup could also clear metadata for a live broker-owned Appium server without broker process-tree termination. |
| Operation serialization | Stop, owner cleanup, all-project stop, and delete acquire the same SHA-256 owner/backend/device operation lock used by broker and direct-provider paths. They re-read and exactly match the expected record before any provider command. |
| State transition | Successful stop and delete use an exact-record compare-and-set transition under the owner-state mutation lock. A same-ID successor written by a non-cooperating process during the provider command is preserved and reported as `owner-device-state-conflict`. |
| Shared lease generation | Admin physical lease release requires the current device's claim ID and claim nonce in addition to owner, backend, hardware, and device identity. Legacy device metadata releases only a legacy lease without generation fields. A same-owner/same-device successor claim therefore survives stale cleanup. |
| Appium boundary | Direct cleanup does not treat a PID as authority. Complete broker-owned Appium metadata is inspected using its persisted process identity; a matching live process or unavailable identity fails closed and retains state, while exited or PID-reused stale metadata remains cleanable. Ordinary asynchronous `ccc devices stop/delete` continues to route through the broker, which owns full Appium process-tree cleanup. |
| Adversarial coverage | Regressions install a successor while the operation lock is held, bypass the lock during stop and delete provider commands, persist a current-process Appium runtime, and replace a physical claim with the same owner/device identity but a new generation. They prove no stale provider dispatch before lock revalidation, exact successor preservation after dispatch, no direct cleanup of live Appium authority, and no stale lease release. The related admin, session, and container suites passed 8 files and 266 tests. |
| Test stability | The first full run after the final lease change hit the pre-existing macOS fake desktop recorder timing edge: its 30-second child had exited before active-state inspection under suite load. The isolated test passed immediately, and the unchanged complete suite then passed on rerun. |
| Release gates | The final single-worker full suite passed with 86 files passed, 7 skipped, 1,779 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed, bundled MCP smoke passed all 81 public tools, and the suite build, TypeScript, lint, MJS syntax, and `git diff --check` passed. Both production audits reported zero vulnerabilities, and the package dry-run contained 163 files. |

## 2026-07-14 Direct Android Lifecycle Generation Fencing

| Area | Evidence |
| --- | --- |
| Failure mode | Direct Android Emulator start, stop, and delete held the cooperative operation lock but wrote or removed current same-ID state after provider effects without verifying the original lifecycle generation. A lock-bypassing writer could install a successor during boot or teardown and have stale completion overwrite it; a superseded start could orphan its emulator process. |
| Lifecycle boundary | Start, stop, and delete atomically claim a random lifecycle runtime ID before host effects. Completion re-reads that generation and applies exact-record CAS under the owner mutation lock. Changed or missing generations return bounded `owner-device-state-conflict` and preserve successor state. |
| Process ownership | Starts persist the fresh launcher PID and process identity. Superseded or failed startup terminates the exact process tree; stop refreshes command identity only within the same PID/start epoch and verifies exit before clearing runtime state. Identity-unavailable startup only drops metadata when fresh-child tree termination is proven. |
| Windows behavior | The hidden VBS launcher waits for the emulator command, preserving a `wscript` parent for identity-checked `taskkill /T` while remaining windowless. POSIX uses the detached process group. |
| Compatibility fencing | Brokers advertise and MCP clients require `direct-android-lifecycle-generation-fencing-v1`, preventing reuse of a same-version broker whose bundled Android provider still performs unconditional lifecycle writes. |
| Adversarial coverage | A fake emulator bypasses the operation lock during boot and replaces `devices.json` with a same-ID successor. The test proves start reports a generation conflict, rolls back the launched process, and preserves successor bytes. State and process tests cover exact CAS, POSIX group kill, Windows tree kill, and PID identity mismatch refusal. Focused Android/state/process and broker compatibility suites passed 8 files and 157 tests. |
| Release gates | The single-worker full suite passed with 86 files passed, 7 skipped, 1,783 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E passed, bundled MCP smoke passed all 81 public tools, and build, TypeScript, and lint passed. Both production audits reported zero vulnerabilities, and the package dry-run contained 163 files. |

## 2026-07-14 Direct iOS Simulator Lifecycle Generation Fencing

| Area | Evidence |
| --- | --- |
| Failure mode | Direct iOS Simulator start, stop, and delete performed simulator effects and then updated or removed whichever same-ID owner record was current. A writer bypassing the cooperative operation lock could install a successor during boot or teardown and have stale completion overwrite or erase it. |
| Lifecycle boundary | Each operation atomically claims a random lifecycle runtime ID before target effects. Completion re-reads that generation and uses exact-record compare-and-set under the owner mutation lock; changed or missing generations return bounded `owner-device-state-conflict` while preserving successor state. |
| Startup rollback | If the claimed generation is superseded during `simctl bootstatus`, CCC invokes `simctl shutdown` for the exact owned UDID that it just booted and reports rollback status with the conflict. Failed pre-completion operations restore only their still-current lifecycle generation. |
| Stop failure preservation | A non-stopped simulator requires available `xcrun`; a failed `simctl shutdown` aborts the stop generation and restores the exact prior running generation. CCC no longer reports a simulator as stopped when the host shutdown effect was unavailable or failed. |
| Compatibility fencing | Brokers advertise and MCP clients require `direct-ios-lifecycle-generation-fencing-v1`, preventing reuse of a same-version broker whose bundled iOS provider retains unconditional lifecycle writes. |
| Adversarial coverage | The fake `simctl` harness bypasses the operation lock during bootstatus, shutdown, and delete by replacing `devices.json` with a same-ID successor. Tests prove start rolls back the boot, all three operations preserve the successor exactly, and a failed shutdown restores the prior lifecycle generation. The focused iOS, state, and broker compatibility suites cover 5 files and 137 tests. |
| Release gates | The final single-worker full suite passed with 86 files passed, 7 skipped, 1,787 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E plus bundled MCP smoke passed 65 of 65 checks with no skips. Build, TypeScript, lint, MJS syntax, and both production audits passed; the package dry-run contained 163 files. |

## 2026-07-15 Direct Windows Sandbox Lifecycle Generation Fencing

| Area | Evidence |
| --- | --- |
| Failure mode | Direct Windows Sandbox start, stop, and delete updated or removed whichever same-ID record was current after provider effects. Singleton update and release matched only owner, device, and sandbox IDs, allowing stale same-owner work to remove a successor claim. Duplicate start could replace its own live singleton generation before detecting the running host instance. |
| State generation | All three lifecycle operations claim a random runtime ID before effects and use exact-record compare-and-set for completion. A changed or missing generation returns bounded `owner-device-state-conflict` and preserves the successor record. Scratch removal occurs only after successful delete CAS. |
| Singleton authority | Lifecycle state persists the singleton `claimId`; runtime-ID update and release require that exact claim. Running records with a missing lock atomically reclaim the exact sandbox GUID before stop, while a foreign lock fails before watchdog or `wsb stop` effects. Existing claims cannot be replaced merely because owner and device IDs match. |
| Rollback and recovery | A superseded start stops its newly observed runtime, cleans the minimize watchdog, and releases only its claim generation. Provider stop failure restores the prior running lifecycle while preserving any watchdog cleanup already completed. Duplicate start is rejected before config, provider, or singleton mutation. |
| Compatibility fencing | Brokers advertise and MCP clients require `direct-windows-lifecycle-generation-fencing-v1`, preventing reuse of a same-version broker with stale owner-state or singleton-release behavior. |
| Adversarial coverage | The fake `wsb` command bypasses the operation lock during start, stop, and forced delete, installs exact same-ID successor records, and replaces the singleton with a same owner/device/sandbox but new claim ID. Tests prove all successors and successor locks survive, missing locks are safely reclaimed, foreign locks prevent stop dispatch, and duplicate start leaves the original lock and provider log unchanged. Focused Windows and broker compatibility suites cover 4 files and 122 tests. |
| Release gates | The single-worker full suite passed with 86 files passed, 7 skipped, 1,791 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E plus bundled MCP smoke passed 65 of 65 checks with no skips. Build, TypeScript, lint, MJS syntax, and both production audits passed; the package dry-run contained 163 files. |

## 2026-07-15 Direct macOS VM Lifecycle Generation Fencing

| Area | Evidence |
| --- | --- |
| Failure mode | Direct macOS VM start, stop, and delete applied provider effects and then updated or filtered whichever same-ID owner record was current. Duplicate start also launched the same provider instance again. Managed-resource delete updated snapshot and recovery metadata without proving that its lifecycle generation remained current. |
| Lifecycle boundary | Start, stop, and delete atomically claim a random lifecycle runtime ID before provider effects. Completion uses exact-record compare-and-set; changed or missing generations return `owner-device-state-conflict` and preserve the successor record. State readback after each persisted transition accounts for JSON canonicalization before the next exact comparison. |
| Startup rollback | A superseded start issues the provider stop command only when its lifecycle still owns the record or the successor names a different provider instance. If a successor claims the same instance, rollback fails closed with `provider-instance-owned-by-successor` rather than stopping successor authority. Duplicate starts are rejected before provider commands. |
| Delete recovery | Successful snapshot and restore-candidate deletions are removed from only the current deleting generation. A later provider failure restores the original lifecycle status while retaining this progress, so retries do not repeat already completed destructive effects. Final record removal is an exact compare-and-set. |
| Compatibility fencing | Brokers advertise and MCP clients require `direct-macos-lifecycle-generation-fencing-v1`, preventing reuse of a same-version broker whose bundled macOS provider retains unconditional lifecycle writes. This capability intentionally excludes snapshot mutation fencing. |
| Adversarial coverage | The fake Tart executable replaces `devices.json` atomically during run, stop, and delete with exact same-ID successors. Regressions prove all successors survive byte-equivalent parsing, stale operations report generation conflicts, startup rollback does not target the successor instance, and duplicate start emits no provider command. Focused macOS and broker compatibility suites passed 4 files and 109 tests. |
| Remaining macOS work | Snapshot create/restore/delete still require their own generation contract, and force-clone must lock and fence the source device rather than only the target. These remain explicit production-hardening work and prevent declaring the overall goal complete. |
| Release gates | The single-worker full suite passed with 86 files passed, 7 skipped, 1,792 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E plus bundled MCP smoke passed 65 of 65 checks with no skips. Build, TypeScript, lint, MJS syntax, and both production audits passed; the package dry-run contained 163 files. |

## 2026-07-15 Direct macOS Snapshot and Clone Generation Fencing

| Area | Evidence |
| --- | --- |
| Failure mode | Snapshot create, restore, and delete performed multiple Tart effects and then updated whichever same-ID owner record was current. A force clone locked only the target, could stop a source without preserving that state transition exactly, and could finish from a source generation replaced during the provider clone. |
| Multi-device serialization | Clone derives the target ID before entering the provider and acquires source and target owner-device locks in sorted, deduplicated order. Inverse concurrent requests serialize without deadlock, while nested reentrant locking retains the existing operation context. |
| Snapshot generation boundary | Create, restore, and delete claim an operation-specific lifecycle generation before provider effects. Completion re-reads that generation and uses exact-record compare-and-set; a changed or missing generation returns `owner-device-state-conflict` and preserves successor state. Newly created resources are rolled back only when the successor does not reference them. |
| Restore recovery | Restore revalidates its generation after candidate creation, primary deletion, activation, and candidate cleanup. It does not delete the primary after losing authority. If activation or cleanup fails after destructive progress, the candidate is preserved and recorded in `restoreRecovery` for deterministic recovery rather than being orphaned or silently discarded. |
| Clone source authority | Source-backed clone holds a source lifecycle generation across force-stop and clone. A successful force-stop clears runtime and recording metadata only through the exact generation. Source replacement aborts target publication, preserves the successor, and deletes the unowned target clone. |
| Compatibility fencing | Brokers advertise and MCP clients require `direct-macos-snapshot-clone-generation-fencing-v1`, preventing reuse of a same-version broker whose bundled provider lacks snapshot staging or source-generation fencing. |
| Adversarial coverage | A fake Tart provider bypasses cooperative locks and replaces source or target state during snapshot clone, snapshot delete, restore candidate creation, and source-backed clone. Tests prove successor preservation, rollback of unowned resources, and that restore never deletes the primary after generation loss. The focused macOS, operation-lock, and broker compatibility suites passed 5 files and 112 tests. |
| Release gates | The final single-worker full suite passed with 86 files passed, 7 skipped, 1,793 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E plus bundled MCP smoke passed 65 of 65 checks with no skips. TypeScript, ESLint, both production audits, and `git diff --check` passed; the package dry-run contained 163 files. |

## 2026-07-15 Direct Physical State Transition Fencing

| Area | Evidence |
| --- | --- |
| Failure mode | Direct physical Android and iOS stop or detach validated the exact lease before work, but then cleared volatile metadata or filtered the owner device array by ID after process effects. A writer bypassing the cooperative operation lock could install a same-ID successor during recording or Appium cleanup and have stale work overwrite or delete that successor. |
| Lifecycle boundary | Stop and detach atomically claim a random lifecycle runtime ID before volatile-process effects. Recording and Appium exit callbacks can clear their own generation-scoped metadata while retaining the lifecycle claim. Final metadata clearing or record removal re-reads that claim and commits with exact-record compare-and-set. |
| Lease behavior | A stale detach never releases a lease after losing owner-state authority. Successful detach removes the exact claimed record first and then releases only its persisted claim ID and claim nonce, so a successor attachment and successor lease survive stale cleanup. |
| Failure preservation | A changed or missing lifecycle returns bounded `owner-device-state-conflict`. iOS process-cleanup failure aborts only the still-current lifecycle and restores its prior status while retaining any valid internal cleanup progress. Physical devices remain powered on by stop and detach as before. |
| Compatibility fencing | Brokers advertise and MCP clients require `physical-direct-state-transition-fencing-v1`, preventing reuse of a same-version broker whose bundled direct physical providers retain unconditional owner-state writes. |
| Adversarial coverage | Fake ADB replaces Android owner state during `pkill`; fake Appium replaces iOS owner state during session deletion. MCP stdio regressions prove stop and detach preserve exact same-ID successors for both platforms. The focused direct-provider and broker compatibility suites passed 5 files and 115 tests. |
| Independent stability fix | The first full run exposed a clock boundary in Windows Sandbox minimize confirmation: `timeoutMs=0` could skip an already-present result if the wall clock advanced before the loop condition. Confirmation now performs one bounded file inspection before checking the remaining wait, and its 64-test broker command suite passes. |
| Release gates | After the stability fix, the final single-worker full suite passed with 86 files passed, 7 skipped, 1,795 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E plus bundled MCP smoke passed 65 of 65 checks with no skips. TypeScript, ESLint, MJS syntax, both production audits, and `git diff --check` passed; the package dry-run contained 163 files. |

## 2026-07-15 Shared Broker Multi-Project Owner Routing

| Area | Evidence |
| --- | --- |
| Failure mode | A canonical container mount such as `/project/<project-id>` was hashed again by MCP owner discovery, producing a different owner from host CCC. The global broker runtime also resolved only the project that launched it, and accepting another mount without a host-path mapping would translate that project's file parameters through the launch project's directory. |
| Canonical identity | Host and container owner helpers now recognize the validated canonical mount form and retain its project ID. Profile validation and owner-basis derivation remain identical on both sides. |
| Registration boundary | Host CCC atomically registers the canonical owner, mount path, profile, and absolute host project path before broker launch or reuse. Registration files are owner-named, bounded, no-follow state files under a validated non-symlink directory chain. Their owner ID, basis, mount, profile, and host-path-derived project ID are revalidated on every read. |
| Resolve and RPC routing | Owner resolve provisions authentication only for an exact registered canonical identity. Missing registrations return `project-owner-unavailable`; malformed or tampered records fail closed. Authenticated RPC dispatch clones broker options with the registered owner's host project path, while preserving the broker executable and provider configuration from the shared daemon. |
| Compatibility fencing | Brokers advertise and MCP clients require `multi-project-owner-resolve-v1`, preventing a current client from reusing a broker that only recognizes its launch project or routes foreign project paths through the wrong host root. |
| Adversarial coverage | Regressions cover canonical owner derivation, malformed canonical mounts and profiles, unregistered owner rejection without auth provisioning, tampered registration rejection, one broker resolving multiple registered projects, and project-B upload path translation to project B rather than broker-launch project A. The impacted owner, broker, MCP routing, and Docker suites passed 8 files and 301 tests before the final release-gate run. |
| Release gates | The final single-worker full suite passed with 86 files passed, 7 skipped, 1,802 tests passed, and 50 platform skips. Source and packaged authenticated broker E2E plus bundled MCP smoke passed. TypeScript, ESLint, MJS syntax, both production audits, the personal-path scan, and `git diff --check` passed; the package dry-run contained 163 files. |

## 2026-07-15 Runtime MCP Bundle Synchronization

| Area | Evidence |
| --- | --- |
| Failure mode | Container MCP configuration executes image-baked `/opt/ccc/dist/*/server.mjs` files. During same-version development or a hotfix build, the host CLI and broker could be current while a reused container retained an older device-lab client because image selection considered the unchanged release version valid. |
| Runtime contract | Every successful container creation, restart, and healthy reuse synchronizes the three CCC-managed bundled MCP entrypoints from the executing CLI package. The image remains self-contained for initial startup, while the host CLI package is authoritative for subsequent sessions. |
| Atomicity and validation | A source bundle must be a non-empty regular non-symlink file no larger than 32 MiB. A matching host/container SHA-256 skips transfer. Otherwise Docker or Podman copies it to a per-process container staging path; root installs the completed file with fixed ownership and mode, then removes staging. A failed stage never touches the destination, a failed install performs bounded staging cleanup while retaining the previous entrypoint, and a post-install digest mismatch removes the invalid destination rather than executing corrupted bytes. |
| Deployment behavior | The published npm package already contains `dist/index.js`, `dist/docker.js`, and all bundled MCP entrypoints. A source installation whose Windows launcher points at the repository `dist/index.js` needs only the normal build; the next `ccc` invocation performs broker compatibility repair and container bundle synchronization without a separate image rebuild. |
| Regression evidence | Container lifecycle and synchronization tests cover successful installation of all managed bundles, matching-digest transfer elision, symlink rejection, bounded input validation, stage failure preservation, post-install digest verification, and removal of an invalid destination. The Docker/index regression set passed 222 tests before the digest follow-up; the final Docker suite passed 103 tests. Package, MCP configuration, and broker suites passed another 85 tests. TypeScript build, bundled MJS syntax, ESLint, `git diff --check`, and the 163-file package dry-run passed. |
| Live container proof | Running the built synchronizer through the real Docker socket against the current project container changed the stale device-lab bundle from SHA-256 `7492de62...` to the host build's `08913570...`; x11 and lab bundles already matched and were not rewritten. A second synchronization preserved all three destination mtimes, proving digest-based transfer elision. A fresh stdio smoke against `/opt/ccc/dist/device-lab-mcp/server.mjs` passed all 81 advertised public tool dispatches. The already-connected MCP process still requires a normal session restart to load the replaced module bytes. |
| Final release gates | The final single-worker full suite passed with 86 files passed, 7 skipped, 1,808 tests passed, and 50 platform skips. Build, TypeScript, ESLint, bundled MJS syntax, source and packaged broker E2E, both production audits, package dry-run, and `git diff --check` passed. |

## Current Follow-Up Queue

### Windows Host Broker Repair Identity

- Windows broker repair now gives `Get-NetTCPConnection` and CIM process
  inspection up to 10 seconds. The former 1.5-second bound could expire while
  PowerShell initialized its networking or CIM providers and leave a verified
  stale broker permanently occupying the configured port.
- If Windows identifies the listening PID but CIM redacts its command line,
  repair accepts it only when the PID and port also match both the local
  `ccc-host` runtime record and the broker's `/status` process record. A
  non-empty command line must still match `ccc devices broker serve`; unrelated
  processes remain non-terminable.
- The focused broker suite includes the command-line-redaction recovery case and
  passes 44 tests. A live `ccc devices broker status` invocation subsequently
  replaced the stale runtime and reported `brokerReady: true`.

### Android And Windows Live Follow-Up

The following checklist is the fixed completion gate for the current live-host
hardening pass. Completion is binary and evidence-based; percentage estimates
are not used.

- [x] Broker automatic replacement and version compatibility are proven on the
  Windows host.
- [x] The real Android emulator lifecycle, ADB controls, Appium controls, and
  destructive Level 3 path are proven.
- [x] Android stop clears `bootReady` and `lastBootCheck`, and stopped status
  reports `runtimeState: stopped` with stopped readiness.
- [x] Windows Sandbox discovery, definition, start, stop, timeout routing, and
  best-effort minimize failure isolation are proven.
- [x] Active Windows helper scripts are not atomically replaced while the
  Sandbox mapped folder holds them open.
- [x] A real Windows Sandbox guest command returns a validated helper response.
- [x] A real Windows Sandbox screenshot returns image content.
- [x] The live Windows proof definition and all test-owned provider processes
  are stopped and deleted.
- [x] The final full test, lint, package dry-run, and diff gates pass after the
  live fixes.
- [x] This audit records the final live Windows evidence and the final commit.

- A real headless Android emulator completed start, ADB property execution,
  screenshot, UIAutomator hierarchy dump, Appium clipboard set/get, Home, and
  stop through the public device-lab MCP. Stopped status correctly tolerates a
  missing ADB target. The live run also exposed stale `bootReady` and
  `lastBootCheck` metadata after stop; stop now clears both fields and the
  broker advertises `stopped-android-boot-metadata-v1`.
- A real Windows Sandbox `wsb start` completed and registered a runtime, but the
  public lifecycle request previously had a 30-second MCP HTTP deadline while
  the lower broker layer allowed 120 seconds. The public default is now 120
  seconds, with a focused timeout regression.
- The same Windows run proved that failure to confirm window minimization was
  incorrectly treated as a provider-start failure and stopped the healthy
  Sandbox. Window minimization is now best effort: the runtime remains running,
  `minimizeConfirmed` records the observed result, and `minimizeWarning`
  preserves the diagnostic. The broker advertises
  `windows-sandbox-best-effort-minimize-v1` and package version `1.1.62` forces
  replacement of the earlier `1.1.61` runtime.
- Post-build Android start/stop proof now confirms `bootReady: false`,
  `lastBootCheck: null`, `runtimeState: stopped`, and stopped readiness. Windows
  live testing exposed and regression-tested active mapped-helper replacement,
  missing one-shot helper installation, and unreliable nested `-Command`
  quoting. The file-backed one-shot request now reaches `wsb exec`, but the
  guest process reports exit code 1 while `wsb.exe` itself exits 0. Guest exit
  parsing and owner-scoped exception capture identified the concrete failure:
  `C:\ccc\tools\ccc-guest-helper.ps1` was absent in the guest. The generated
  `.wsb` nested a read-only `tools` mapping inside an already mapped writable
  device root, and Windows Sandbox did not expose the nested mapping. Version
  `1.1.68` removes the overlapping root mapping and maps the four writable file
  channels individually while retaining a separate read-only tools mapping.
  The focused Windows suite fixes this five-mapping contract and passes all 18
  tests. Live `1.1.68` startup then proved that broker-routed lifecycle commands
  use a separate host-broker config generator and retained an older canonical
  `.wsb` file. Version `1.1.69` applies the same five-mapping contract in the
  broker and refreshes canonical owner configs immediately before a real start;
  custom noncanonical config paths remain untouched. The combined broker and
  backend Windows suites pass 84 tests, including a stale-config start
  regression. Live `1.1.69` then reached the corrected guest mappings and
  exposed a second broker-only omission: config generation wrote the bootstrap
  launchers but never installed `ccc-guest-helper.ps1` into the read-only tools
  mapping. Version `1.1.70` packages the backend-generated helper as a shared
  asset, verifies it before atomically installing it for broker-created and
  broker-refreshed definitions, and returns the effective refreshed provider
  command in diagnostics. Generator/asset identity, package inclusion, helper
  installation, and refreshed-command regressions pass in the 95-test focused
  set; the final broker/backend rerun passes 85 tests. Real command and
  screenshot proof were the remaining live completion gates at that point.
- The reloaded `1.1.70` broker reported RPC readiness on PID `10048`. The real
  Windows proof start returned identical five-folder XML in its planned and
  executed provider commands. `device_exec` returned status `0`, provider
  `windows-helper`, and stdout `ccc-windows-live-proof`. `device_screenshot`
  returned actual image content showing the Sandbox desktop. The Sandbox then
  stopped successfully, its proof definition was deleted, and final Windows
  Sandbox and Android emulator owner inventories were both empty.
- Final repository gates passed after that live proof: 86 test files passed and
  7 platform-only files skipped; 1,813 tests passed and 50 platform cases
  skipped, with zero failures. ESLint passed. `npm pack --dry-run --json`
  produced a 164-file `1.1.70` package and explicitly included
  `device-lab-mcp/src/backends/windows-helper.ps1`. Build and
  `git diff --check` passed. The platform skips remain honest environmental
  limits rather than evidence for unavailable iOS/macOS/physical-device hosts.

Run full strict proof on hosts with the required providers and leased hardware
until the final summary reports `skip=0`, `fail=0`, and
`strictSkipFailures=0`.
