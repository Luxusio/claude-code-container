# Architecture verification workflow

This policy keeps the architecture migration moving while preserving its
operation, ownership, packaging and native acceptance requirements. A focused
or preflight PASS is scoped evidence; it is not whole-project completion.

## Verify in increasing cost order

1. Check the changed operation's contracts, actual caller bindings and focused
   behavior. Reuse existing tests for unchanged lower-level authority.
2. Check current source and emitted declarations, package layout and the whole
   affected lightweight consumer before expensive process or toolchain checks.
3. Run complete npm and Unix distribution verification for a ready integration
   batch. Each form must retain its required consumer ledger and negative cases.
4. Run the required portable regression suite and compiled CLI checks for that
   combined revision, then verify local source/artifact delivery.
5. Record real-host and reliability evidence separately. Fixtures and missing
   hosts cannot silently discharge native requirements.

Run the smallest meaningful failing consumer first after a failure. Once it
passes, continue the remaining required gates. Do not restart every successful
phase merely because a later assertion or observer failed.

## Reuse a genuine build

Build once for the production source, compiler options, dependency versions and
build inputs under test. Inspect the complete build chain; npm postinstall exit
zero alone is insufficient when an installer can mask a failed build.

Record source and artifact hashes before reuse. A test-only, documentation-only
or checker-only change does not require rebuilding unchanged production output.
A changed production dependency, build configuration, missing output or failed
authentication does. Do not run a Vitest wrapper that implicitly rebuilds when
the intended check is a reader of existing authenticated output.

## Keep fixtures and oracles accurate

- Preserve immutable original controls. When a reviewed change intentionally
  changes a result, add an explicit current-intent oracle; do not overwrite the
  historical result or derive the expected result by calling the implementation.
- Scope declaration checks to the interface or factory they protect. Optional
  display parameters do not make required execution capabilities optional.
- Register strict consumer inputs explicitly. A defined but unscheduled type
  fixture provides no evidence. Check source and genuine emission when required.
- Distinguish executable modules from separate packaged assets. Retain bounded
  reads and file identity checks without granting the subject new authority.
- Count denied effects before throwing, including caught attempts. Scope file
  descriptors, processes, generations and network endpoints to their allocations.
- Retain submitted inputs, bounded raw results and failure context before
  assertions or cleanup. Preserve the primary error if cleanup also fails.
- Join owned actors before disposing their roots. Preserve unknown or unsettled
  actors and borrowed evidence; a name or stale PID is not ownership proof.

Characterize meaningful success, refusal, partial effect, failure and successor
cases at the operation boundary. Exercise actual public bindings and retain
existing authority regressions. Avoid copying an entire verification framework
or constructing an exhaustive matrix of unsupported JavaScript object behavior
for each small extraction.

## Separate selected checks from full acceptance

A selected preflight uses the same checked consumer functions as full execution.
It reports its exact checks and explicitly states that the result is partial.
It must not silently launch npm packing, Go, providers or the full suite. Invalid
selection must fail before those operations. Full execution remains the default
and retains both payload forms and every required consumer.

The fixed runner interface is:

```sh
node scripts/test-workspace-packages.mjs --preflight --payload-root "$VERIFIED_PAYLOAD"
node scripts/test-workspace-packages.mjs
```

The selected payload must be an authenticated assembled copy, with an absolute,
canonical, owned path and the required package layout. Ownership alone does not
authenticate its code. Reject invalid flags and paths before allocating scratch
files or dispatching checks. Preflight runs current declaration contracts and
the whole image-preparation gate; the command without flags runs full verification.

Do not reconstruct temporary copies of checker functions to choose a check.
Use the explicit runner entry point. A targeted diagnostic remains useful
evidence, but cannot be relabeled as a complete distribution or Goal verdict.

## Review and integrate without repeating work

Review a coherent operation packet, including its Guide, contracts and caller
binding. After a bounded correction, carry forward unaffected actual reviews and
review the changed behavior and its dependencies. Fresh required reviews precede
substantive QA; missing hook receipts do not authorize fabricated attestations.

Commit reviewable source packets and integrate ready disjoint packets regularly.
Reserve shared entrypoint writers explicitly. Update WBS completion only when
the operation's required integration and delivery evidence exists; file counts,
partial bindings and successful mock cleanup are not completion credit.

Use local verification. Hosted CI, pushes and global installation require the
user's authorization. This workflow adds no container memory policy, Cargo
parallelism default, protocol change or OpenCode support.
