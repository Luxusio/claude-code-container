export function sessionClaimPrefix(projectId: string, profile?: string): string {
    return profile ? `${projectId}--p--${profile}` : projectId;
}

export function sessionClaimName(prefix: string, sessionId: string): string {
    return `${prefix}--${sessionId}.lock`;
}

export type SessionClaimOwnershipKind = "direct" | "monitored";

export function encodeSessionClaim(pid: number, startToken: string | null, ownershipKind?: SessionClaimOwnershipKind): string {
    if (ownershipKind !== undefined) {
        if ((ownershipKind !== "direct" && ownershipKind !== "monitored") || !Number.isSafeInteger(pid) || pid <= 0
            || (startToken !== null && (typeof startToken !== "string" || !startToken.length || startToken.length > 256))) {
            throw new TypeError("Invalid session claim owner.");
        }
        return JSON.stringify({ version: 3, pid, startToken, ownershipKind });
    }
    return startToken ? JSON.stringify({ version: 2, pid, startToken }) : String(pid);
}

export function sessionLockClaimsForContainer(entries: string[], containerPrefix: string): string[] {
    const isProfilePrefix = containerPrefix.includes("--p--");
    return entries.filter((name) => {
        if (!name.endsWith(".lock")) return false;
        if (name.startsWith(`${containerPrefix}--`)) {
            if (isProfilePrefix) {
                const sessionId = name.slice(containerPrefix.length + 2, -".lock".length);
                return sessionId.length > 0 && !sessionId.includes("--");
            }
            return !name.slice(containerPrefix.length + 2).startsWith("p--");
        }
        if (!isProfilePrefix && name.startsWith(`${containerPrefix}-`)) {
            return !name.slice(containerPrefix.length + 1).startsWith("-");
        }
        return false;
    });
}

export function sessionLockClaimsForProjectFamily(entries: string[], projectId: string): string[] {
    return entries.filter((name) => name.endsWith(".lock") && name.startsWith(`${projectId}--`));
}
