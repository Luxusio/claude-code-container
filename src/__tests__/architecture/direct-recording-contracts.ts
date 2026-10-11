import { createDirectRecording } from '../../../packages/device-lab/providers/adapters/direct-recording.mjs';
import { createDirectRecordingApplication } from '../../../packages/device-lab/providers/application/direct-recording.mjs';
import type { DirectRecordingNative, DirectRecordingPorts, AndroidRecordingPorts } from '../../../packages/device-lab/providers/ports/direct-recording.mjs';
export function consumeRecordingConstructors(native: DirectRecordingNative, ports: DirectRecordingPorts, android: AndroidRecordingPorts) {
    const application = createDirectRecording(native);
    const semantic = createDirectRecordingApplication(ports);
    const { findDevice: omitted, ...incomplete } = native; void omitted;
    // @ts-expect-error Native selected-owner record lookup is required.
    const missing: DirectRecordingNative = incomplete;
    const deferredRead: DirectRecordingNative = { ...native,
        // @ts-expect-error Lookup is a synchronous native fact.
        findDevice: async () => null,
    };
    const deferredPublication: AndroidRecordingPorts = { ...android,
        // @ts-expect-error Guarded repository publication must complete synchronously.
        updateDevice: async () => null,
    };
    const missingCommandReceipt: AndroidRecordingPorts = { ...android,
        // @ts-expect-error Individual command effect requires a concrete status/stdout/stderr receipt.
        copyRecording: () => undefined,
    };
    return { application, semantic, missing, deferredRead, deferredPublication, missingCommandReceipt };
}
