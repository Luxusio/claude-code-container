import { createContainerImagePreparation } from "../../application/container-image-preparation.js";
import type {
    ContainerImagePreparationOutcome,
    ContainerImagePreparationPorts,
    ContainerImagePreparationRequest,
    ImageTagOutcome,
} from "../../ports/container-image-preparation.js";
import type { NativeContainerImagePreparationHelpers } from "../../composition/container-image-preparation.js";

declare const ports: ContainerImagePreparationPorts;
const app = createContainerImagePreparation(ports);
const request: ContainerImagePreparationRequest = { imageName: "ccc", version: "1.2.3", registryImage: "team/image" };
const result: ContainerImagePreparationOutcome = app.run(request);
const present: boolean = ports.exists();
const label: string | null = ports.label("ccc", "cli.version");
const qualified: string = ports.qualify("team/image:1.2.3");
const pulled: boolean = ports.pull(qualified);
const tagged: ImageTagOutcome = ports.tag(qualified, "ccc");
declare const native: NativeContainerImagePreparationHelpers;
const nativeTag: ImageTagOutcome = native.tagImage(qualified, "ccc");
void [result, present, label, qualified, pulled, tagged, nativeTag];

// The reusable result is finite and contains no native process receipt.
const outcomes: ContainerImagePreparationOutcome[] = [
    { kind: "completed", source: "development" },
    { kind: "completed", source: "matching" },
    { kind: "completed", source: "registry" },
    { kind: "completed", source: "fallback" },
    { kind: "failed", reason: "image-pull-failed", reference: qualified },
    { kind: "failed", reason: "image-tag-failed" },
    { kind: "indeterminate", reason: "image-tag-unconfirmed" },
];
void outcomes;

function inspectOutcome(outcome: ContainerImagePreparationOutcome): string {
    if (outcome.kind === "completed") return outcome.source;
    if (outcome.reason === "image-pull-failed") return outcome.reference;
    return outcome.reason;
}
void inspectOutcome;

type Assert<T extends true> = T;
type EveryPortRequired = Assert<{
    [K in keyof ContainerImagePreparationPorts]: {} extends Pick<ContainerImagePreparationPorts, K> ? false : true
}[keyof ContainerImagePreparationPorts] extends true ? true : false>;
type AsyncPort<T extends (...args: never[]) => unknown> = (...args: Parameters<T>) => Promise<ReturnType<T>>;
type EveryPortSynchronous = Assert<{
    [K in keyof ContainerImagePreparationPorts]:
        AsyncPort<ContainerImagePreparationPorts[K]> extends ContainerImagePreparationPorts[K] ? false : true
}[keyof ContainerImagePreparationPorts] extends true ? true : false>;
const required: EveryPortRequired = true;
const synchronous: EveryPortSynchronous = true;
void [required, synchronous];

// @ts-expect-error The operation has no ambient capabilities.
createContainerImagePreparation();
// @ts-expect-error Required ports cannot be absent.
createContainerImagePreparation(undefined);
// @ts-expect-error Every capability is required.
createContainerImagePreparation({ exists: ports.exists });
// @ts-expect-error Ports must be callable.
createContainerImagePreparation({ ...ports, reportPull: true });
// @ts-expect-error Existence remains synchronous and boolean.
createContainerImagePreparation({ ...ports, exists: async () => true });
// @ts-expect-error Inspection remains synchronous and nullable.
createContainerImagePreparation({ ...ports, label: async () => null });
// @ts-expect-error Qualification returns a synchronous reference.
createContainerImagePreparation({ ...ports, qualify: async ref => ref });
// @ts-expect-error Pull returns a synchronous boolean.
createContainerImagePreparation({ ...ports, pull: async () => true });
// @ts-expect-error Semantic tag observations must remain synchronous.
createContainerImagePreparation({ ...ports, tag: async () => ({ kind: "completed" as const }) });
// @ts-expect-error Permissive void does not prove synchronous completion.
createContainerImagePreparation({ ...ports, reportPull: (): void => {} });
// @ts-expect-error Native results cannot escape through observation ports.
createContainerImagePreparation({ ...ports, tag: () => ({ status: 0 }) });
// @ts-expect-error An absent receipt does not establish tag completion.
createContainerImagePreparation({ ...ports, tag: () => undefined });
// @ts-expect-error Tag failure reasons are finite.
createContainerImagePreparation({ ...ports, tag: () => ({ kind: "failed", reason: "private stderr" }) });
// @ts-expect-error Raw stdout cannot become an application outcome.
const rawOutcome: ContainerImagePreparationOutcome = { kind: "failed", reason: "image-tag-failed", stderr: "private" };
// @ts-expect-error A successful native tag is not an application completion source.
const noSource: ContainerImagePreparationOutcome = { kind: "completed" };
// @ts-expect-error Tag uncertainty uses its own finite reason.
const wrongReason: ImageTagOutcome = { kind: "indeterminate", reason: "image-tag-failed" };
// @ts-expect-error Native helpers must normalize instead of returning raw receipts.
const rawHelper: NativeContainerImagePreparationHelpers = { ...native, tagImage: () => ({ status: 0 }) };
// @ts-expect-error Native semantic helpers must remain synchronous.
const asyncHelper: NativeContainerImagePreparationHelpers = { ...native, tagImage: async () => ({ kind: "completed" as const }) };
void [rawOutcome, noSource, wrongReason, rawHelper, asyncHelper];
// @ts-expect-error Existence does not expose native status codes.
createContainerImagePreparation({ ...ports, exists: () => 0 });
// @ts-expect-error Label observations use null, not absent undefined.
createContainerImagePreparation({ ...ports, label: () => undefined });
// @ts-expect-error Every request fact is required.
app.run({ imageName: "ccc", version: "1.2.3" });
// @ts-expect-error Version remains a string.
app.run({ ...request, version: 123 });
