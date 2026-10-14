import { createStateFilePublication } from "../../../packages/device-lab/providers/application/state-file-publication.mjs";
import { createSharedMutationLock } from "../../../packages/device-lab/providers/application/shared-mutation-lock.mjs";
import type { CopyResources, CopyStream, PublicationDirectory, PublicationStage, StateFilePublicationPorts } from "../../../packages/device-lab/providers/ports/state-file-publication.d.mts";
import type { LockReadObservation, MutationLockRecord, SharedMutationLockPorts } from "../../../packages/device-lab/providers/ports/shared-mutation-lock.d.mts";

type Fence = readonly PublicationDirectory[];
type Ports = StateFilePublicationPorts<Fence, PublicationStage>;

function publicationCapabilities(ports: Ports, resources: CopyResources, stream: CopyStream): void {
    const application = createStateFilePublication(ports);
    const written: undefined = application.write("/owned/state", "bytes");
    const serialized: undefined = application.writeJson("/owned/state", { devices: [] });
    const copied: number = application.copy("/owned/source", "/owned/destination", { limitBytes: 64 });
    const renamed: undefined = application.rename("/owned/stage", "/owned/destination", () => undefined);
    const { check, ...withoutFence } = ports;
    // @ts-expect-error Publication requires native namespace revalidation.
    createStateFilePublication(withoutFence);
    const { writeStage, ...withoutStageWrite } = ports;
    // @ts-expect-error Publication requires owned exclusive stage writing.
    createStateFilePublication(withoutStageWrite);
    const { removeStage, ...withoutCleanup } = ports;
    // @ts-expect-error Allocated stage cleanup is a required native capability.
    createStateFilePublication(withoutCleanup);
    const { withSource, ...withoutSource } = ports;
    // @ts-expect-error Copying requires guarded native source resources.
    createStateFilePublication(withoutSource);
    // @ts-expect-error Namespace revalidation must settle before native mutation.
    createStateFilePublication({ ...ports, check: async () => undefined });
    // @ts-expect-error One rename attempt must settle synchronously before retry decisions.
    createStateFilePublication({ ...ports, renameAttempt: async () => undefined });
    // @ts-expect-error Output close cannot leave a pending stage lifetime behind.
    createStateFilePublication({ ...ports, closeOutput: async () => undefined });
    // @ts-expect-error The guarded copy resource scope must return its byte outcome synchronously.
    createStateFilePublication({ ...ports, withSource: async () => 0 });
    // @ts-expect-error Native chunk progress cannot be deferred inside the copy loop.
    createStateFilePublication({ ...ports, withSource: (_source, _prefix, _limit, operation) => operation({ ...resources, openOutput: () => ({ ...stream, write: async () => 1 }) }) });
    // @ts-expect-error Resource closure must settle before atomic publication.
    createStateFilePublication({ ...ports, withSource: (_source, _prefix, _limit, operation) => operation({ ...resources, openOutput: () => ({ ...stream, close: async () => undefined }) }) });
    void [written, serialized, copied, renamed, check, writeStage, removeStage, withSource];
}
void publicationCapabilities;

function lockCapabilities(ports: SharedMutationLockPorts<Fence>): void {
    const application = createSharedMutationLock(ports);
    const record: MutationLockRecord | null = application.readLock("/owned/state.lock");
    const raw: LockReadObservation = ports.readRaw("/owned/state.lock");
    const observed: { kind: "value"; value: MutationLockRecord } | { kind: "missing" | "malformed" | "unavailable" } = application.readObservation("/owned/state.lock");
    const archives: string[] = ports.archives("/owned/state.lock", []);
    const removed: boolean = ports.removeArchive("/owned/state.lock", "/owned/state.lock.0123456789abcdef.stale", "a".repeat(32), []);
    const synchronous: string = application.withLock("/owned/state.lock", () => "settled", { reclaimStale: false });
    const asynchronous: Promise<number> = application.withLockAsync("/owned/state.lock", async () => 7, { waitBudget: { remaining: () => 100 } });
    const { readRaw, ...withoutRecord } = ports;
    // @ts-expect-error Current native lock record observation is required.
    createSharedMutationLock(withoutRecord);
    const { openClaim, ...withoutClaim } = ports;
    // @ts-expect-error Lock admission requires native exclusive claim authority.
    createSharedMutationLock(withoutClaim);
    const { moveQualified, ...withoutRelease } = ports;
    // @ts-expect-error Lock release and stale reclaim require token-qualified namespace mutation.
    createSharedMutationLock(withoutRelease);
    const { archives: enumerateArchives, ...withoutArchives } = ports;
    // @ts-expect-error Admission must observe displaced ownership evidence.
    createSharedMutationLock(withoutArchives);
    const { removeArchive, ...withoutArchiveRelease } = ports;
    // @ts-expect-error Exact owned archive release is a required native capability.
    createSharedMutationLock(withoutArchiveRelease);
    const { identityAsync, ...withoutAsyncIdentity } = ports;
    // @ts-expect-error Asynchronous live-owner observation is a required capability.
    createSharedMutationLock(withoutAsyncIdentity);
    // @ts-expect-error Exclusive claim admission must settle synchronously.
    createSharedMutationLock({ ...ports, openClaim: async () => 1 });
    // @ts-expect-error Token-qualified release cannot remain pending after the operation settles.
    createSharedMutationLock({ ...ports, moveQualified: async () => true });
    // @ts-expect-error Archive enumeration must settle before synchronous admission.
    createSharedMutationLock({ ...ports, archives: async () => [] });
    // @ts-expect-error Archive removal must settle inside the owned release lifetime.
    createSharedMutationLock({ ...ports, removeArchive: async () => true });
    // @ts-expect-error Native raw observations must be available synchronously.
    createSharedMutationLock({ ...ports, readRaw: async () => ({ kind: "unavailable" as const }) });
    // @ts-expect-error The synchronous owner observation route cannot yield a Promise.
    createSharedMutationLock({ ...ports, identitySync: async () => null });
    // @ts-expect-error Synchronous contention pause cannot defer lock acquisition.
    createSharedMutationLock({ ...ports, pauseSync: async () => undefined });
    void [record, raw, observed, archives, removed, synchronous, asynchronous, readRaw, openClaim, moveQualified, enumerateArchives, removeArchive, identityAsync];
}
void lockCapabilities;
