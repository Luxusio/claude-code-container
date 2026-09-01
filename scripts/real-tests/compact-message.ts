// Compact a failure reason for single-line reporter output.
//
// The default limit is generous (700) on purpose: producers already bound and
// redact their diagnostics before they reach the reporter (e.g.
// formatBrokerToolFailure caps at 511 chars and redacts every field), so the
// reporter must not re-truncate a bounded guest/boot diagnostic and hide the
// actionable tail (diagnosticErrors / integration services). Modules that need
// a tighter bound self-cap before returning their reason.
export function compactMessage(value: unknown, limit = 700): string {
    const normalized = String(value || "unknown error").replace(/\s+/g, " ").trim() || "unknown error";
    return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}
