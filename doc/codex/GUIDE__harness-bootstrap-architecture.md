# Codex Harness bootstrap policy

This operation has two executable policy boundaries. The host application owns
Codex-lock preparation, bootstrap transport, raw result/output handling,
restoration in finally and the best-effort warning. Embedded Python domain and
application chunks own registration, version, hook identity/digest/trust,
install-only-if-absent, revision verification and post-install probe. Moving only
the host wrapper does not complete this operation.

The native Python adapter retains Path/files/config parsing, executable lookup,
temporary directory, interpreter/home resolution and bounded subprocess/group
authority. The existing public `CODEX_HARNESS_BOOTSTRAP` assembles source chunks;
the container needs no new asset, module import or dependency. The host public
`ensureCodexHarness(containerName, profile?)` remains synchronous void.

## Registration and installation decisions

Literal false plugin/hooks/MCP enablement returns disabled before other checks.
Only absent declarations with no Harness aliases or leftover payload are absent.
Incomplete/custom/unavailable/version-invalid/payload-invalid/trust-invalid user
registrations are refused and preserved. There is no automatic repair or merge.

MCP and hook executable/file lookups retain their short-circuit and first-missing
order. Hook lookup precedes event validation. Only the existing
`PYTHONDONTWRITEBYTECODE=1` prefix is stripped. Identity keeps original command,
event name, command, async value, normalized timeout and optional matcher/status
message in the sorted compact JSON SHA256 digest. Group and hook indices select
the trust key separately and are not included in the digest. No command hooks,
stale hash or disabled trust refuses ready.

Only absent state prints installation progress and opens the original temporary
scope. Application supplies exact pinned Git commands, compares fetched revision
before checkout, invokes the native interpreter/installer with `--codex-only`
and fresh home observation, then re-probes after the temporary scope closes.
Source and revision remain unchanged. No real plugin download/installation is
permitted in portable verification.

## Native authority and failure precedence

Python keeps its absolute 120-second monotonic deadline and native remaining-
budget process session. Timeout kills the owned group with SIGKILL, drains it and
raises the existing error; kill/drain failures retain their masking precedence.
Native file/parser/path/temp/lookup errors remain raw until original stderr/exit1
handling. Pure policy chunks perform no filesystem/process/native callbacks.

Host transport retains selected runtime, exact stdin/environment/workdir/default
identity and 135000ms budget. Preparation precedes transport and restoration
runs once after entered lock callback, even on prepare/output/result failure.
Restore errors can mask earlier failures; failed lock acquisition does not restore.
Nonempty stdout is trimmed and published before execution failure handling.

Native ports are ordinary synchronous functions, with output published through
console.error and warnings through console.warn. Construction checks each required
port is callable without executing it. Warning conversion and invocation can
themselves throw; the best-effort function does not guarantee a no-throw API.
No extra per-call callable validation or error substitution is introduced.

## Verification and acceptance

Actual generated Python execution must cover malformed shapes, literal
booleans, version boundaries, all required files, events/indices/options,
noncommand/nohooks, trust hashes/enablement, every install stage/postprobe/temp
cleanup and timeout kill/drain faults, with surviving bytes and ordered effects.

Every fixture counts denied effects before throwing and before script/import
evaluation, including caught failures. Only exact allocated HOME/cache/temp and
owned process groups/fake Git/installer actions are admitted. Optional real Docker
tests remain disabled in portable QA. Simulated native-process controls establish
policy traces; they do not prove live child-group termination.

Actual Codex fresh/reuse caller must use the real facade and generated Python,
not an ensure mock; Claude remains a negative gate. Root must freshly build both
npm-extracted and installer-materialized payloads, run each actual compiled host
export and Python program under native/fake-transport fences, and compile current
strict declarations. Existing launcher mocks and source-only string inclusion
cannot earn whole-operation credit.

Known ceiling: live Harness/plugin/network/container installation and native UID,
platform, global-main and accepted-parent behavior remain separately unverified.
Independent code/security review, candidate QA and both actual shipping families
are required before operation credit or final architecture claims.
