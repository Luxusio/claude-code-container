import { createPhysicalAttachmentApplication } from "../../../packages/device-lab/providers/application/physical-attachment.mjs";
import { createAndroidPhysicalAttachment, createIosPhysicalAttachment } from "../../../packages/device-lab/providers/adapters/physical-attachment.mjs";
import type { AndroidAttachmentPorts, IosAttachmentPorts, AttachmentOutcome, AttachmentDevice } from "../../../packages/device-lab/providers/ports/physical-attachment.mjs";
import type { AndroidAttachmentNative, IosAttachmentNative } from "../../../packages/device-lab/providers/adapters/physical-attachment.mjs";
declare const android: AndroidAttachmentPorts;
declare const ios: IosAttachmentPorts;
declare const androidNative: AndroidAttachmentNative;
declare const iosNative: IosAttachmentNative;
declare const device: AttachmentDevice;
const result: AttachmentOutcome = createPhysicalAttachmentApplication(android).attach({ backend: "android-device", serial: "owned" });
const detached: Promise<AttachmentOutcome> = createPhysicalAttachmentApplication(ios).detach("owned");
createAndroidPhysicalAttachment(androidNative); createIosPhysicalAttachment(iosNative);
const { claim, ...withoutClaim } = android;
// @ts-expect-error Owner publication is required.
createPhysicalAttachmentApplication(withoutClaim);
// @ts-expect-error Owner publication is synchronous.
const asyncClaim: AndroidAttachmentPorts = { ...android, claim: async () => ({ ok: true }) };
// @ts-expect-error Record discovery is synchronous.
const asyncRead: IosAttachmentPorts = { ...ios, read: async () => [device] };
// @ts-expect-error Lease acquisition must complete before connect/publication.
const asyncLease: AndroidAttachmentPorts = { ...android, claimLease: async () => ({ ok: false }) };
// @ts-expect-error Lease removal transaction is synchronous.
const asyncRelease: IosAttachmentPorts = { ...ios, releaseWithMutation: async () => ({ ok: true }) };
// @ts-expect-error Concrete producer requires the native command leaf.
createAndroidPhysicalAttachment({ ...androidNative, run: undefined });
// @ts-expect-error Native command receipt is synchronous and concrete.
createAndroidPhysicalAttachment({ ...androidNative, run: async () => ({ status: 0, stdout: "", stderr: "" }) });
// @ts-expect-error The actual producer must construct ports from native observations.
createAndroidPhysicalAttachment(android);
function consume(outcome: AttachmentOutcome) {
    if (outcome.kind === "attached") return outcome.device.id;
    if (outcome.kind === "detached") return outcome.deviceId;
    if (outcome.kind === "conflict") return outcome.found;
    if (outcome.kind === "error") return outcome.message;
    if (outcome.kind === "command-failure") return outcome.command.status;
    return undefined;
}
void [result, detached, claim, asyncClaim, asyncRead, asyncLease, asyncRelease, consume];
