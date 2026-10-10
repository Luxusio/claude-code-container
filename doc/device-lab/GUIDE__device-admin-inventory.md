# Device admin inventory

The public CLI enters inventory through `index.main`, `devicesCliAsync` and `devicesCli`. Snapshot and status/list exports remain available from `device-lab-admin`; backends and doctor use the same inventory application.

The application owns owner selection, current-owner/all-project reads, grouping and status/list presentation. The domain owns backend availability, device labels and flag admission. The facade supplies canonical owner/profile resolution, guarded project enumeration, device-record reads and executable lookup through finite ports. Native root, link, generation and storage checks remain at their effect boundaries.

Use current application/domain and type-contract tests for policy and required port contracts. `src/__tests__/device-lab-admin.test.ts` exercises owner namespaces, inventory, diagnostics and formatting; the ordinary Admin smoke/cleanup tests exercise public commands and native safety. Build when production inputs change and run `npm run test:packages` for actual shipped entry points, assets and MCP startup in both distribution forms.

Package smoke does not qualify native OS/provider behavior. Report real-host checks and unavailable hosts separately. Follow [architecture verification](../verification/GUIDE__architecture-verification.md); do not retain archived implementations, internal read-order replay or custom VM facade consumers as acceptance gates.
