# Device Admin cleanup

The [cleanup facade](../../src/device-lab-cleanup.ts) retains synchronous owner/session cleanup. [Device Admin](../../src/device-lab-admin.ts) composes all-project traversal and CLI behavior. Single-device asynchronous stop retains authenticated broker RPC.

The [domain](../../src/domain/device-admin-cleanup.ts) owns eligibility, runtime selection, command facts and cleaned records. The [application](../../src/application/device-admin-cleanup.ts) owns incremental traversal, locked reread, successor refusal, signal/command/wait ordering, classification and conditional publication. [Required synchronous ports](../../src/ports/device-admin-cleanup.ts) expose individual effects; Windows claim release returns `undefined` to reject async substitutions.

Native adapters retain process birth/generation, broker-owned Appium refusal, file guards, locks and physical lease CAS/compensation. Unknown/malformed inventory cannot authorize deletion. Physical iOS cleanup does not power off or disconnect a device. Windows claim release follows successful publication.

Failures retain raw errors and completed partial effects. Later read failure does not undo earlier cleanup. Successors and surviving metadata/leases remain protected, including compensation errors. Cleanup does not absorb prune or introduce stronger ABA guarantees.

Existing [cleanup](../../src/__tests__/device-lab-admin.cleanup.test.ts) and [prune](../../src/__tests__/device-lab-admin.prune.test.ts) suites cover ownership, successors, partial failures, session/CLI routes and required-port negatives. Acceptance uses independent review, current contracts, genuine build, affected regressions and ordinary actual package smoke before local delivery. Native Windows/macOS/provider acceptance remains separate.
