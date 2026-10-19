/** Receipt-bound guardian evidence. Native file identity and invocation validation belong to adapters. */
export interface SessionClaimFileIdentity {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
    readonly birthtime: string;
    readonly digest: string;
}

export interface SessionClaimObservationBinding {
    readonly lockFile: string;
    readonly projectPath: string;
    readonly profile?: string;
    readonly toolName?: string;
    readonly prefix: string;
}

export interface SessionClaimAcknowledgement {
    readonly generation: string;
    readonly sequence: number;
    readonly containerId: string | null;
    readonly cleanupEnabled: boolean;
}

export interface SessionClaimPending extends SessionClaimAcknowledgement {
    readonly kind: "update" | "startup";
}

export interface SessionClaimObservation {
    readonly version: 1;
    readonly claim: SessionClaimFileIdentity & { readonly ownerPid: number };
    readonly binding: SessionClaimObservationBinding;
    readonly runtime: SessionClaimFileIdentity;
    readonly guardian: { readonly pid: number; readonly startToken: string | null };
    readonly registration: "pending" | "ready";
    readonly generation: string;
    readonly pending: SessionClaimPending | null;
    readonly lastAcknowledged: SessionClaimAcknowledgement | null;
    readonly ownStarted: { readonly generation: string; readonly containerId: string } | null;
    readonly recovery: { readonly status: "active" | "recovery-needed"; readonly diagnostic: string | null };
}

const invalid = (): never => { throw new TypeError("Invalid session claim observation."); };

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const keys = Reflect.ownKeys(value);
    if (required.some(key => !keys.includes(key))
        || keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key)
            || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return invalid();
    return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 4096): string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value)
        ? value : invalid();
}

function generation(value: unknown): string { return text(value, 128); }
function pid(value: unknown): number { return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : invalid(); }
function fullId(value: unknown): string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalid(); }
function nullableId(value: unknown): string | null { return value === null ? null : fullId(value); }

function identity(value: unknown, owner = false): SessionClaimFileIdentity & { ownerPid?: number } {
    const source = record(value, ["path", "device", "inode", "birthtime", "digest", ...(owner ? ["ownerPid"] : [])]);
    const numeric = (value: unknown): string => typeof value === "string" && /^\d{1,40}$/.test(value) ? value : invalid();
    return Object.freeze({ path: text(source.path), device: numeric(source.device), inode: numeric(source.inode),
        birthtime: numeric(source.birthtime), digest: fullId(source.digest), ...(owner ? { ownerPid: pid(source.ownerPid) } : {}) });
}

function acknowledgement(value: unknown, pending: boolean): SessionClaimAcknowledgement | SessionClaimPending {
    const source = record(value, ["generation", "sequence", "containerId", "cleanupEnabled", ...(pending ? ["kind"] : [])]);
    if (!Number.isSafeInteger(source.sequence) || Number(source.sequence) < 0 || typeof source.cleanupEnabled !== "boolean"
        || (pending && source.kind !== "update" && source.kind !== "startup")) return invalid();
    return Object.freeze({ generation: generation(source.generation), sequence: Number(source.sequence),
        containerId: nullableId(source.containerId), cleanupEnabled: source.cleanupEnabled,
        ...(pending ? { kind: source.kind as "update" | "startup" } : {}) });
}

export function decodeSessionClaimObservation(value: unknown): SessionClaimObservation {
    const source = record(value, ["version", "claim", "binding", "runtime", "guardian", "registration", "generation",
        "pending", "lastAcknowledged", "ownStarted", "recovery"]);
    if (source.version !== 1 || (source.registration !== "pending" && source.registration !== "ready")) return invalid();
    const binding = record(source.binding, ["lockFile", "projectPath", "prefix"], ["profile", "toolName"]);
    const guardian = record(source.guardian, ["pid", "startToken"]);
    const recovery = record(source.recovery, ["status", "diagnostic"]);
    if (recovery.status !== "active" && recovery.status !== "recovery-needed") return invalid();
    const ownStarted = source.ownStarted === null ? null : record(source.ownStarted, ["generation", "containerId"]);
    const result: SessionClaimObservation = Object.freeze({
        version: 1, claim: identity(source.claim, true) as SessionClaimObservation["claim"], runtime: identity(source.runtime),
        binding: Object.freeze({ lockFile: text(binding.lockFile), projectPath: text(binding.projectPath), prefix: text(binding.prefix, 512),
            ...(binding.profile !== undefined ? { profile: text(binding.profile, 256) } : {}),
            ...(binding.toolName !== undefined ? { toolName: text(binding.toolName, 256) } : {}) }),
        guardian: Object.freeze({ pid: pid(guardian.pid), startToken: guardian.startToken === null ? null : text(guardian.startToken, 256) }),
        registration: source.registration, generation: generation(source.generation),
        pending: source.pending === null ? null : acknowledgement(source.pending, true) as SessionClaimPending,
        lastAcknowledged: source.lastAcknowledged === null ? null : acknowledgement(source.lastAcknowledged, false),
        ownStarted: ownStarted === null ? null : Object.freeze({ generation: generation(ownStarted.generation), containerId: fullId(ownStarted.containerId) }),
        recovery: Object.freeze({ status: recovery.status, diagnostic: recovery.diagnostic === null ? null : text(recovery.diagnostic, 512) }),
    });
    if (result.claim.path !== result.binding.lockFile || new TextEncoder().encode(JSON.stringify(result)).byteLength > 16384) return invalid();
    return result;
}

export function currentSessionClaimAuthority(observation: SessionClaimObservation): { containerId: string; source: "ack" | "own-start" } | null {
    const own = observation.ownStarted;
    const pending = observation.pending;
    const ack = observation.lastAcknowledged;
    const currentAck = ack?.generation === observation.generation ? ack : null;
    if (own?.generation === observation.generation
        && (!currentAck || (currentAck.cleanupEnabled && currentAck.containerId === own.containerId))
        && (!pending || (pending.generation === observation.generation && pending.cleanupEnabled
            && (pending.kind === "startup" || pending.containerId === own.containerId)))) {
        return { containerId: own.containerId, source: "own-start" };
    }
    if (observation.registration === "ready" && !pending && ack?.generation === observation.generation
        && ack.cleanupEnabled && ack.containerId !== null) return { containerId: ack.containerId, source: "ack" };
    return null;
}

/** Every supplied peer has already been qualified by its native reader; null means unknown evidence. */
export function sessionClaimPeerVetoes(ownContainerId: string | null, peers: readonly (SessionClaimObservation | null)[]) {
    const ownValid = typeof ownContainerId === "string" && /^[a-f0-9]{64}$/.test(ownContainerId);
    return { sharedDeviceCleanupBlocked: peers.length > 0, exactContainerStopBlocked: peers.some(peer => {
        const ack = peer?.lastAcknowledged;
        return !ownValid || !peer || peer.registration !== "ready" || peer.pending !== null
            || ack?.generation !== peer.generation || typeof ack.containerId !== "string"
            || !/^[a-f0-9]{64}$/.test(ack.containerId) || ack.containerId === ownContainerId;
    }) };
}

export function canTransferSessionClaimObligation(from: SessionClaimObservation, to: SessionClaimObservation): boolean {
    const source = currentSessionClaimAuthority(from);
    const target = to.lastAcknowledged;
    return from.claim.path !== to.claim.path && source !== null && to.registration === "ready" && to.pending === null
        && target?.generation === to.generation && target.cleanupEnabled && target.containerId === source.containerId
        && from.runtime.digest === to.runtime.digest && from.binding.prefix === to.binding.prefix;
}

/** Called only for the qualified, positively dead cohort. Differing authorities remain incomplete. */
export function selectSessionClaimRecoverySurvivor(observations: readonly SessionClaimObservation[]): SessionClaimObservation | null {
    if (!observations.length) return null;
    const eligible = observations.filter(item => item.registration === "ready" && item.pending === null
        && item.lastAcknowledged?.generation === item.generation && item.lastAcknowledged.cleanupEnabled
        && item.lastAcknowledged.containerId !== null
        && currentSessionClaimAuthority(item)?.containerId === item.lastAcknowledged.containerId);
    const survivor = [...eligible].sort((a, b) => a.claim.path < b.claim.path ? -1 : a.claim.path > b.claim.path ? 1 : 0)[0];
    if (!survivor) return null;
    return observations.every(item => item === survivor || canTransferSessionClaimObligation(item, survivor)) ? survivor : null;
}
