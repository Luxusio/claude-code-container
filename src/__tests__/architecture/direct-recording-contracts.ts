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
    const semanticCopy: AndroidRecordingPorts = { ...android,
        copyRecording: () => ({ ok: true, detail: '', output: { stdout: 'copied', stderr: '', status: 0 } }),
        fallbackStop: () => ({ ok: false }),
        observeGuest: () => ({ status: 'unavailable' }),
        removeRecording: () => undefined,
    };
    const capturedTarget = { kind: 'adb' as const, executable: '/selected/adb', prefix: ['-s', 'selected-device'] };
    const revalidatedTarget = android.target({}, 'device_record_video_stop', { capturedTarget, waitBudget: { remaining: () => 1000 } });
    // @ts-expect-error Revalidation carries the parent's live allowance, never a fresh scalar timeout.
    android.target({}, 'device_record_video_stop', { capturedTarget, waitBudget: 3000 });
    const rawFallback: AndroidRecordingPorts = { ...android,
        // @ts-expect-error Android fallback acknowledgement is a finite native fact.
        fallbackStop: () => ({ status: 0, stdout: '', stderr: '' }),
    };
    const rawGuestObservation: AndroidRecordingPorts = { ...android,
        // @ts-expect-error Native pidof output is classified before entering the application.
        observeGuest: () => ({ status: 1, stdout: '', stderr: '' }),
    };
    const incompleteAndroid: AndroidRecordingPorts = { ...android,
        // @ts-expect-error Unavailability is explicit; null cannot be interpreted as guest absence.
        observeGuest: () => null,
    };
    const consumeSettlement = (fallback: ReturnType<AndroidRecordingPorts['fallbackStop']>, guest: ReturnType<AndroidRecordingPorts['observeGuest']>) => {
        // @ts-expect-error Native exit status is not an inward fallback fact.
        const nativeStatus: number | null = fallback.status;
        // @ts-expect-error Native guest output is not an inward observation fact.
        const nativeOutput: string = guest.stdout;
        return { ok: fallback.ok, status: guest.status, nativeStatus, nativeOutput };
    };
    const rawCopy: AndroidRecordingPorts = { ...android,
        // @ts-expect-error Native status/stdout/stderr is normalized before entering the application.
        copyRecording: () => ({ status: 0, stdout: '', stderr: '' }),
    };
    const missingCopyDetail: AndroidRecordingPorts = { ...android,
        // @ts-expect-error Copy failure detail is supplied by the native adapter.
        copyRecording: () => ({ ok: false, output: {} }),
    };
    const missingCopyOutput: AndroidRecordingPorts = { ...android,
        // @ts-expect-error Public compatibility output is an explicit opaque fragment.
        copyRecording: () => ({ ok: true, detail: '' }),
    };
    const consumeCopy = (copy: ReturnType<AndroidRecordingPorts['copyRecording']>) => {
        // @ts-expect-error Native status is not an inward copy observation field.
        const status: number | null = copy.status;
        // @ts-expect-error Native stderr is not an inward copy observation field.
        const stderr: string = copy.stderr;
        // @ts-expect-error Adapter-prepared output fields remain opaque to application decisions.
        const outputStatus: number = copy.output.status;
        return { ok: copy.ok, detail: copy.detail, output: copy.output, status, stderr, outputStatus };
    };
    return { application, semantic, missing, deferredRead, deferredPublication, semanticCopy, revalidatedTarget, rawFallback, rawGuestObservation, incompleteAndroid, consumeSettlement, rawCopy, missingCopyDetail, missingCopyOutput, consumeCopy };
}
