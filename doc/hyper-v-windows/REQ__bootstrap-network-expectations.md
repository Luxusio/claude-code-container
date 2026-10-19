# Bootstrap network expectations at the Hyper-V boundary

This engineering contract derives from the accepted [library boundary ADR](ADR__library-boundary.md): Device Lab chooses its identities; the reusable library receives and verifies explicit expectations. It does not add a user-facing network option or claim public package compatibility.

## Guest boot

The Linux `Configure-VMGuestBoot` request requires `expectedBootstrapAdapterName`, `expectedBootstrapSwitchName` and `expectedBootstrapMacAddress`. Both public client and execution-request types preserve that Linux/Windows correlation. Omitted or explicit Windows requests forbid all three fields.

Both names are actual nonempty strings, at most 100 characters, without C0 controls or wildcard characters. TypeScript and PowerShell apply the same bounds before native effects. Names retain their spelling and are compared case-sensitively; neither layer substitutes a CCC default.

MAC identity uses the existing generic parser's bare, colon or hyphen spelling and canonical comparison. Malformed, mixed-separator and all-zero values are invalid. Generic admission does not impose CCC's `06` prefix or another address-class policy. This broadens the reusable operation's accepted identities; the Device Lab caller still supplies its existing derived address.

The native operation checks the supplied adapter, switch and MAC at both VM-local and host-wide checks. Exact VM ID/name/Notes, Off state, generation, sole OS disk, Gen1 IDE controller, media absence and unique host MAC remain required immediately before attachment. Firmware/readback, Windows integration-service behavior, Linux integration-state preservation and uncertain-result cleanup are unchanged.

The changed operation asset requires broker protocol 6. The existing shared protocol check rejects protocol 5 before provider execution so its in-memory digest pin cannot be reused with the new asset. Existing identity-fenced repair owns replacement; newer protocols are never downgraded.

## Creation planning

The `managed-and-bootstrap` intent requires an explicit `bootstrapMacAddress`. The planner validates both MACs, rejects canonical equality even when case or separators differ, and emits the supplied bootstrap assignment. It does not derive an address from the managed one. `none` and `managed` intents retain their existing behavior.

Device Lab derives its existing `02` to `06` address while constructing the intent. Its host-conflict preflight and readback compare that supplied value. The seed caller supplies `CCC Bootstrap DHCP`, `Default Switch` and the same derived MAC. Library operations do not decide those values.

## Verification and limits

Exercise arbitrary safe names and non-`06` addresses, both generations, malformed/missing/forbidden fields, canonical address collisions, exact serialized transport input, unchanged Windows requests and Device Lab's existing selected values. Compile positive and negative consumers for both request unions and the creation intent. Verify the actual shipped asset digest.

Portable transport/planner tests and source guard assertions do not establish native PowerShell execution. Parser/Pester and disposable Windows Hyper-V acceptance remain separate parent-goal evidence. This contract concerns these two bootstrap paths; it does not certify the entire library or architecture migration.
