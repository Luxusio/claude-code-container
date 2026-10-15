# Android wireless architecture

Android wireless transport preparation uses one JavaScript implementation for `status`, `usb-tcpip`, `pair`, and `connect`. The direct MCP server calls the public async `handleAndroidRealTool` export. The authenticated broker selects the same Android backend module and invokes that export through its native backend child. Broker authentication, path translation and process guards remain at their existing boundaries.

The domain owns wireless endpoints, serial formatting and attach-next advice. Shared native mobile inventory decoding owns the ADB device-list parser used by inventory, status and attachment. Endpoint rules retain existing falsy coercion, embedded ports, bracketed IPv6, serial precedence and default port behavior.

The application owns fresh discovery admission and the complete four-action
sequence: required arguments, endpoint selection, TCP/IP or pairing, optional
connection and attachment advice. Synchronous ports provide normalized device
inventory and finite mutation success facts with opaque native evidence. The
application returns status, completed, refused or command-failed outcomes;
the backend owns argv, raw receipt classification and JSON/text presentation.
Native mutation success remains `status === 0`, including contradictory receipt
error fields. No generic command runner or publisher is injected inward.

Status executes `adb devices -l` without a wireless timeout override; native `run` retains its existing 120000 ms default. A failed inventory observation remains nested as `hostDevices.available: false` under the existing successful status response. Mutations retain the original timeout expression `Math.max(1, Math.min(Number(timeoutMs || 15000), 30000))`; the native timeout runner is selected before timeout coercion. No retry, deadline or stricter endpoint validation is added.

TCP/IP and pairing execute before a later optional connect target can be refused.
Their completed preparation evidence remains in that refusal or a subsequent
connect failure. Native pairing evidence masks the code in argv, stdout, stderr
and error/validation diagnostics before returning it to policy or presentation.
No automatic retry or connection fallback is introduced.

Wireless preparation does not attach a device or mutate owner state, physical leases, recordings or Appium sessions. Successful `usb-tcpip`, `pair` and `connect` responses retain `stateMutated: false`; status omits that field. `attachNext` advises a separate `device_attach`, which retains its existing ownership and lease authority.

Portable controls can verify command arguments, outcomes and both actual dispatch routes using private fake commands. They do not establish real Android USB trust, TCP/IP switching, Android 11+ pairing, Wi-Fi reachability, SDK readiness or platform acceptance. Both shipped forms and final integration acceptance are separate required gates.
