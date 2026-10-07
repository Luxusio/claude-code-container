# Separate complete home layout migration policy

The synchronous `migrateHomeLayout` facade now invokes a pure application behind
semantic ports. The application owns pending work, default profile suffixes,
clipboard preflight and move order, conflict tracking, remote JSON parsing and
merge policy, and cleanup order. Public options and results move unchanged to
ports and remain reexported by the facade.

Native filesystem operations, migration-lock takeover, startup identity receipts,
config publication and best-effort cleanup remain in `src/home-layout.ts`.
Callback receivers, deferred clock evaluation, repeated observations, broad
fallbacks, raw warning diagnostics and existing catch boundaries are preserved.
Startup receipts pass through the application without interpretation.

Remote config publication precedes ordered source deletion. Existing destination
entries retain precedence, invalid JSON stays in place, and later unlink failure
keeps earlier effects without reporting partial remote moves. Clipboard conflicts
and unsafe state defer migration; clipboard move failure stops later moves.

See [the migration guide](../home/GUIDE__layout-migration.md) for behavior and
boundaries. Planned acceptance covers pure core, actual facade and declaration
proofs, retained regressions, and both compiled shipping forms. Independent review
and fresh QA remain required; this note does not assert their results.

The existing migration remains one-way: code rollback cannot reverse user data
moves. Native macOS/Windows acceptance, other M11 operations and M12–M14 remain
separate work; this extraction does not complete the architecture migration.
