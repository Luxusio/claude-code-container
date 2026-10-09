# Android wireless architecture

Android wireless transport preparation uses one JavaScript implementation for `status`, `usb-tcpip`, `pair`, and `connect`. The direct MCP server calls the public async `handleAndroidRealTool` export. The authenticated broker selects the same Android backend module and invokes that export through its native backend child. Broker authentication, path translation and process guards remain at their existing boundaries.

The domain module owns the existing ADB inventory and wireless endpoint parsers, serial formatting, command payload projection and attach-next advice. Inventory and attachment reuse these exact helpers. Endpoint rules retain existing falsy coercion, embedded ports, bracketed IPv6, serial precedence and default port behavior.

The application owns fresh discovery admission and the complete four-action sequence: status inventory interpretation, required arguments, endpoint selection, TCP/IP or pairing, optional connection, raw command success/failure classification, response construction and attachment advice. Its required synchronous ports provide fresh discovery, a raw device-list observation, distinct TCP/IP/pair/connect executions, and selection of the existing JSON/text publishers. Factory construction does not read native getters or discover tools. The backend composes these capabilities with the existing native commands and response functions.

Status executes `adb devices -l` without a wireless timeout override; native `run` retains its existing 120000 ms default. A failed inventory observation remains nested as `hostDevices.available: false` under the existing successful status response. Mutations retain the original timeout expression `Math.max(1, Math.min(Number(timeoutMs || 15000), 30000))`; the native timeout runner is selected before timeout coercion. No retry, deadline or stricter endpoint validation is added.

TCP/IP and pairing execute before a later optional connect target can be refused. Their completed command evidence remains in that refusal. Pairing payloads replace only argument index 2 with `[redacted]`; stdout, stderr and error messages preserve the existing raw diagnostics. Result fields, getter order, publisher selection and public async settlement preserve the established facade behavior.

Wireless preparation does not attach a device or mutate owner state, physical leases, recordings or Appium sessions. Successful `usb-tcpip`, `pair` and `connect` responses retain `stateMutated: false`; status omits that field. `attachNext` advises a separate `device_attach`, which retains its existing ownership and lease authority.

Portable controls can verify command arguments, outcomes and both actual dispatch routes using private fake commands. They do not establish real Android USB trust, TCP/IP switching, Android 11+ pairing, Wi-Fi reachability, SDK readiness or platform acceptance. Both shipped forms and final integration acceptance are separate required gates.
