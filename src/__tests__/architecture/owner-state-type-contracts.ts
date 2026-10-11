import { validateOwnerDevicePayload } from "../../../packages/device-lab/providers/domain/owner-device-payload.mjs";
import { createOwnerStateContent } from "../../../packages/device-lab/providers/application/owner-state-content.mjs";
import type { OwnerStateContentPorts } from "../../../packages/device-lab/providers/ports/owner-state-content.d.mts";

export function checkOwnerStateContract(parsed: unknown): unknown[] | null {
    const result = validateOwnerDevicePayload(parsed, /safe/);
    if (result.kind === "valid") return result.devices;
    // @ts-expect-error Invalid outcomes never expose a usable device array.
    result.devices;
    return null;
}

// @ts-expect-error ID policy must be an explicit regular expression.
validateOwnerDevicePayload({}, "safe");

function consumedOwnerContentCapabilities(ports: OwnerStateContentPorts, devices: unknown[]): void {
    const application = createOwnerStateContent(ports);
    const read: unknown[] = application.read(() => '{"devices":[]}');
    const writable: undefined = application.assertWritable(devices, 256 * 1024);
    const { idPattern, ...withoutPattern } = ports;
    // @ts-expect-error Owner device identity admission requires the current ID pattern.
    createOwnerStateContent(withoutPattern);
    const { byteLength, ...withoutByteLength } = ports;
    // @ts-expect-error Writable admission requires native UTF-8 byte measurement.
    createOwnerStateContent(withoutByteLength);
    const { isStateError, ...withoutRecognition } = ports;
    // @ts-expect-error Known native state errors require class-specific recognition.
    createOwnerStateContent(withoutRecognition);
    const { stateError, ...withoutErrorConstruction } = ports;
    // @ts-expect-error Invalid or oversized content requires the native error constructor.
    createOwnerStateContent(withoutErrorConstruction);
    // @ts-expect-error Bounded content cannot be read asynchronously by this synchronous application.
    application.read(async () => '{"devices":[]}');
    // @ts-expect-error Writable admission cannot defer the byte ceiling observation.
    createOwnerStateContent({ ...ports, byteLength: async () => 0 });
    // @ts-expect-error Native state-error recognition must settle before classification.
    createOwnerStateContent({ ...ports, isStateError: async () => false });
    // @ts-expect-error Error construction must provide an Error synchronously.
    createOwnerStateContent({ ...ports, stateError: async () => new Error("deferred") });
    void [read, writable, idPattern, byteLength, isStateError, stateError];
}
void consumedOwnerContentCapabilities;
