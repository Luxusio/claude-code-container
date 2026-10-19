export type SessionLockLiveness = "active" | "stale" | "unknown";

export type ProcessStartObservation =
    | { status: "found"; token: string }
    | { status: "present" }
    | { status: "missing" }
    | { status: "unknown" };

export interface SessionLockOwner {
    pid: number;
    startToken?: string;
    ownershipKind?: "direct" | "monitored";
}

export function sessionLockOwner(content: string): SessionLockOwner | null {
    try {
        const parsed = JSON.parse(content) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const record = parsed as { version?: unknown; pid?: unknown; startToken?: unknown; ownershipKind?: unknown };
            if (record.version === 3) {
                if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
                    || (record.ownershipKind !== "direct" && record.ownershipKind !== "monitored")
                    || (record.startToken !== undefined && record.startToken !== null
                        && (typeof record.startToken !== "string" || record.startToken.length === 0 || record.startToken.length > 256))
                    || Object.keys(record).some(key => !["version", "pid", "startToken", "ownershipKind"].includes(key))) return null;
                return { pid: Number(record.pid), ...(typeof record.startToken === "string" ? { startToken: record.startToken } : {}),
                    ownershipKind: record.ownershipKind };
            }
            if (record.version !== 2 || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
                || typeof record.startToken !== "string" || record.startToken.length === 0
                || record.startToken.length > 256) {
                return null;
            }
            return { pid: Number(record.pid), startToken: record.startToken };
        }
    } catch {
        // Legacy lock files contain only the decimal PID.
    }
    const legacy = content.trim();
    if (!/^[1-9]\d*$/.test(legacy)) return null;
    const pid = Number(legacy);
    return Number.isSafeInteger(pid) ? { pid } : null;
}
