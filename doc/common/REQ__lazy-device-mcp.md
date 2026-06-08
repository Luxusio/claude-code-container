---
type: REQ
status: candidate
created: 2026-06-08
source: user request, official Windows Sandbox CLI docs, official Android Emulator command-line docs, MCP transport specification
---

# Lazy Device MCP

CCC should support optional MCP tools for disposable Windows and Android
environments without requiring those environments to run during normal sessions.

## Intent

Expose disposable OS, browser, mobile, and device environments through
CCC-managed MCP servers so coding agents can start, inspect, interact with,
and stop isolated experiment targets only when a task needs them.

## Observable Behaviors

1. A normal `ccc` session should not start Windows Sandbox, Android Emulator,
   an Android VM, or any host-side device controller.
2. CCC should install or generate MCP entries that are always visible to the
   agent, but those entries should be lightweight launchers until a tool call
   requests a device session.
3. The first Windows tool call should start or attach to a Windows Sandbox
   session through a host-side controller when the host supports Windows
   Sandbox.
4. The first Android tool call should start or attach to an Android Emulator
   device through a host-side controller when an Android SDK and AVD are
   available.
5. The container should communicate with host-side controllers over loopback
   forwarding or stdio wrappers, reusing CCC's existing host reachability and
   MCP config generation patterns.
6. The feature should degrade cleanly with actionable diagnostics when Windows
   Sandbox, virtualization, Android SDK tools, or AVD images are missing.
7. Device MCP availability should not require environment variables. CCC should
   auto-detect host capabilities and choose safe defaults; explicit user
   control should live in CCC CLI commands or CCC-owned config files instead of
   per-session environment setup.
8. Device MCP tools should let the agent manage device inventory and lifecycle:
   list available device definitions, create a device definition, delete a
   device definition, start a device instance, stop a device instance, inspect
   status, run commands, transfer files through scoped mounts, and capture
   screenshots.
9. Device ownership should be isolated per CCC container/session identity. A
   container should only list, start, stop, mutate, or delete device definitions
   and running device instances that belong to that container identity unless
   the user explicitly runs a host-side administrative command.
10. On macOS hosts, CCC should support a macOS virtual machine device backend
    when the host provides a practical virtualization provider. This backend
    should follow the same lazy lifecycle and per-container ownership model as
    Windows and Android devices.
11. When a guest OS control API cannot return command output directly, CCC may
    use a small guest-side helper process for command execution, file transfer,
    screenshots, and readiness checks. This helper should be installed only
    inside the disposable guest environment and should communicate with the host
    broker through a scoped channel.
12. On macOS hosts with Xcode installed, CCC should support iOS Simulator as a
    lazy device backend. The backend should expose simulator inventory and
    lifecycle management through MCP, including list, create, delete, boot,
    shutdown, app install/launch, command execution where supported, screenshots,
    video capture where supported, and data reset.
13. CCC should be able to grow into a broad experiment environment matrix. Each
    backend should share a common lifecycle contract while preserving backend
    specific capabilities and limitations.

## Non-goals

- Running a nested Android VM inside the CCC container by default.
- Running nested desktop OS virtualization inside the CCC container by default.
- Attempting to run iOS Simulator on non-macOS hosts or without Xcode.
- Keeping Windows Sandbox or Android Emulator alive after the requesting CCC
  session exits unless the user explicitly asks for persistence.
- Mapping arbitrary writable host directories into disposable device
  environments without an explicit allowlist.
- Requiring users to export CCC-specific environment variables before device
  MCP tools appear or work.
- Allowing one CCC project/container to control device instances owned by
  another CCC project/container.

## Verification Cues

- `ccc` startup remains unchanged when no device MCP tool is called.
- A Windows MCP smoke test can start a sandbox, run a simple command, capture
  evidence, and stop the sandbox.
- An Android MCP smoke test can start an AVD, wait for boot completion, run
  `adb shell` and screenshot commands, and stop the emulator.
- Two concurrent CCC containers receive separate device namespaces; each MCP
  server sees only its own created devices and cannot stop the other's running
  instance.
- Missing host prerequisites produce concise diagnostics and do not break other
  CCC-managed MCP servers.
