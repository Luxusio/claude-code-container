# Provider failure evidence

Status: derived implementation contract, 2026-10-26.

## Basis and outcome

The user requests repairs based on saved failures and actual Mac verification.
The subsequent Level 3 run reaches 84 passed records and four failures after
endpoint isolation. Its iOS diagnostic retains only the tool name, two Tart
diagnostics omit nested boot evidence, and one internal broker assertion loses
its process-verification evidence during message truncation. These facts are
recorded in the [failure chronology](../changes/2026-10-22-test-failure-groups.md).

The following diagnostic choices derive from those missing facts. They do not
establish an underlying native timeout, changed process, shell or boot failure.
Preserve failures until actual host evidence establishes their cause.

## Observable behavior

iOS observation/access command failures retain their existing error text and
`isError` result, and additionally expose selected native execution facts through
the standard MCP `structuredContent` object. Retain status, signal, timeout and
closed error/diagnostic codes when present. Do not add raw output, command
arguments, paths or credentials to that object. Do not change simulator commands,
ownership admission, retries or time limits as part of this correction.

The real-test parser prefers valid structured failure objects and otherwise
retains its existing JSON-content handling. Saved evidence and short messages
select only bounded diagnostic facts. Recognize Tart's actual lifecycle shape
at `result.execution.command.macosBoot`, alongside existing boot shapes. Keep
start-process failures distinguishable from IP-readiness failures using observed
facts; missing evidence stays missing. Internal unexpected broker errors use
the same diagnostic writer before assertion messages lose their payload.

MCP native broker observations use completed command output for ownership
verification. Preserve fixed executables, full command width, exact entry/PID/
birth/status checks, and existing allowances. Failed, interrupted or incomplete
observations refuse verification. Closed observation-stage codes may explain
refusal; they do not supply authority to restart or signal a process.

Artifacts continue to omit host paths, credentials, endpoints and raw command
output. A diagnostic-write failure preserves the original operation failure.
Short messages remain bounded. No retry, timeout increase or skip may turn these
four observed failures into passes without a demonstrated correction.

## Verification

Use private native-command and MCP fixtures to prove complete observation
requirements, structured iOS transport, actual nested Tart boot shapes, internal
assertion evidence and sensitive-field omission. Keep process start failure,
IP timeout and unknown observations distinct. Run only affected owners and
relevant regression checks. Native Mac execution remains required to establish
the residual provider failures' actual causes and acceptance.
