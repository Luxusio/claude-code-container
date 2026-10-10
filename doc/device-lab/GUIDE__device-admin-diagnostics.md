# Device admin diagnostics

`deviceLabSmoke`, `deviceLabBenchHealth`, `formatDevicesDoctor` and `formatDevicesSmoke` compose the diagnostics application. The synchronous `devices doctor` and `devices smoke` CLI routes use that same application. Smoke argument admission, prerequisite outcomes, physical inventory and lease classification, installed MCP outcomes, and report presentation belong inward. Inventory is an existing application peer.

The required ports expose owner and device reads, guarded lease reads, executable lookup, host facts, file existence, clocks, and bounded commands. The admin facade binds those ports to existing native authorities. Importing or constructing the application does not start a provider. Real-provider smoke performs readiness and inventory commands without creating or claiming devices. A failed physical inventory is optional unless an explicit target is configured. Installed MCP smoke reports its own dispatch failure.

The current ordinary suites cover CLI admission, diagnostics outcomes and lease ownership. Independent review and shared strict/build/runtime QA are required before acceptance. Real Windows, macOS and physical-device certification remain separate from Linux test results.
