import { renderStageCleanupFailure } from './stage-cleanup-result.mjs';
/** @typedef {import('./stage-cleanup-result.mjs').CleanupNativeResult} DesktopTransferNativeResult */

/** @param {import('../domain/desktop-control-transfer.mjs').DesktopCleanupFailure} outcome
 * @param {(primary:import('../domain/desktop-control-transfer.mjs').DesktopResult)=>DesktopTransferNativeResult} renderPrimary
 * @param {(value:object)=>DesktopTransferNativeResult} jsonResult
 * @returns {DesktopTransferNativeResult} */
export function renderDesktopTransferCleanup(outcome, renderPrimary, jsonResult) {
    const primary = outcome.cleanup.primary;
    return renderStageCleanupFailure({
        error: 'desktop-transfer-cleanup-failed',
        primary: primary.kind === 'thrown' ? primary
            : { kind: 'returned', outcome: primary.kind, result: renderPrimary(primary) },
        cleanupError: outcome.cleanup.error,
        ...(primary.kind === 'completed' ? { result: { kind: 'completed', completed: true } } : {}),
    }, jsonResult);
}
