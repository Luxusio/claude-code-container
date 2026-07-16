const VALID_STATUSES = new Set(["PASS", "SKIP", "FAIL"]);

export function aggregateStepResult(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
        return { status: "FAIL", reason: "test returned no result steps" };
    }
    const invalid = steps.filter((step) => !VALID_STATUSES.has(step?.status));
    if (invalid.length > 0) {
        const names = invalid.map((step, index) => step?.name || `step-${index + 1}`).join(", ");
        return { status: "FAIL", reason: `test returned invalid step status: ${names}` };
    }
    if (steps.some((step) => step.status === "FAIL")) return { status: "FAIL" };
    if (steps.some((step) => step.status === "PASS")) return { status: "PASS" };
    const reasons = [...new Set(steps
        .filter((step) => step.status === "SKIP" && step.reason)
        .map((step) => String(step.reason)))];
    return { status: "SKIP", reason: reasons.join("; ") || "all test steps skipped" };
}
