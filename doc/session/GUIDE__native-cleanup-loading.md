# Native cleanup loading

Public session cleanup is synchronous. Its native adapter imports the cohesive `device-lab-cleanup` module instead of the administrative CLI graph. The administrative facade reexports the cleanup API. Inward session policy depends on ports; native composition owns the cleanup adapter and provider effects.

The cleanup module coordinates owner records, mutation/operation locks, current-record comparison, physical leases, Windows generation checks, process identity, provider stop commands and bounded waiting. Tests should directly exercise these current safety requirements and partial failures rather than replay an archived implementation. The guardian readiness acknowledgement and its later terminal-cleanup import are separate startup boundaries.

Use `src/__tests__/architecture/session-cleanup.test.ts` and its type contracts for inward policy and import direction. Ordinary `device-lab-admin.cleanup.test.ts`, `device-lab-safe-cleanup.test.ts`, `device-lab-safe-cleanup-lock.integration.test.ts` and session/broker lifecycle regressions cover public cleanup, ownership, successors, locks and process safety. Build when production inputs change, then use the small `npm run test:packages` smoke for actual shipped npm/Unix startup and assets.

These local checks do not qualify real providers, native operating systems or container engines. Report unrun host checks explicitly. Follow [architecture verification](../verification/GUIDE__architecture-verification.md), without frozen-source/hash witnesses, declaration-body catalogs, original/current parity or custom cleanup realms.
