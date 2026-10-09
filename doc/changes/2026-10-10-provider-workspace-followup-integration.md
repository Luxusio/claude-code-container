# Provider, workspace, Admin and QEMU integration

This integration continues the hexagonal migration for Codex and Claude. It combines eleven provider/workspace operations with four independently reviewed Admin/QEMU operations. Their final shipping and portable acceptance is still pending; the accepted WBS baseline remains 68/218.

## Verification cadence

Disjoint source and test authors work in parallel. Reviewed production code is built in one immutable QA checkout while separate authors prepare the finite shipping fixtures. Only one heavy QA lane runs. The final combined candidate receives one complete build, focused and affected regression checks, both installer forms and one full configured portable suite before local delivery and operation credit. A failed build is retried after its source correction; a checker-only or documentation correction does not invalidate an unchanged successful production build.

Committed source authentication uses batched Git tree/blob reads. Observed authentication decreased from approximately five minutes to 5–10 seconds for the same authenticated inputs. Complete successful file results can carry only when their actual transitive source and emitted dependencies remain unchanged. A new HEAD, test count or observer line alone never establishes acceptance.

Compiler-language failures are reproduced with the authenticated compiler and real strict options in private bounded probes before another production correction. The probes preserve positive and negative contract consumers and do not count as successful product builds.

## Verification quality

Immutable original implementation controls and independently frozen expectations remain separate from the candidate. Fixtures check initialization observations independently of invocation observations. Nondecreasing test clocks preserve the original native operation counters and deadlines. Denied filesystem, process, network and environment effects are counted before throwing, including caught attempts.

Shipping consumers use the owned stdin runner and retain the submitted program, input, raw output and result receipt before asserting success. Primary failures survive evidence and cleanup errors. Source, output, dependency, link and actor identity checks remain required. Temporary author drafts are embedded into the tracked checker; a fresh checkout does not depend on task or temporary files.

The new Admin proof executes the complete compiled CLI caller. QEMU proofs execute the existing package handlers and direct MCP image listing, preserve omission of disk/target public tools, and retain unsupported broker behavior. No new successful broker QEMU route is inferred.

## Current limits

Current focused provider/workspace checks previously passed 33 complete files, but affected results must be reevaluated against the combined candidate. Failed shipping attempts and failed builds remain retained evidence. Native host/provider acceptance remains separate. Missing Harness hook receipts are non-attesting and never become a formal close PASS. No hosted CI, push, global installation or resource-default change is part of this work.
