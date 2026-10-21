import { desktopPointValid, desktopDragValid } from '../domain/desktop-control-transfer.mjs';
/** @typedef {import('../domain/desktop-control-transfer.mjs').DesktopArguments} Arguments */
/** @typedef {import('../domain/desktop-control-transfer.mjs').DesktopOutcome} Outcome */
/** @typedef {import('../domain/desktop-control-transfer.mjs').DesktopResult} Result */
/** @param {string} message @returns {Result} */
const refused = message => ({ kind: 'refused', message });
/** @param {string} name @param {unknown} evidence @returns {Result} */
const failed = (name, evidence) => ({ kind: 'failed', name, evidence });
/** @param {string} name @param {Arguments} args @param {import('../ports/desktop-control-transfer.mjs').NativeObservation} observation @returns {Result} */
const observed = (name, args, observation) => observation.ok ? { kind: 'completed', name, args, evidence: observation.evidence } : failed(name, observation.evidence);
/** @param {Arguments} args @returns {import('../ports/desktop-control-transfer.mjs').DragArguments} */
const dragArguments = args => ({ x1: Number(args.x1), y1: Number(args.y1), x2: Number(args.x2), y2: Number(args.y2), durationMs: args.durationMs ?? 700 });
/** @param {string} name
 * @param {import('../domain/desktop-control-transfer.mjs').DesktopResult|{kind:'thrown',error:unknown}} primary
 * @param {()=>undefined} dispose
 * @returns {import('../domain/desktop-control-transfer.mjs').DesktopResult|import('../domain/desktop-control-transfer.mjs').DesktopCleanupFailure} */
function finalizeStage(name, primary, dispose) {
    try { dispose(); }
    catch (error) { return { kind: 'failed', name, evidence: error, cleanup: { primary, error } }; }
    if (primary.kind === 'thrown') throw primary.error;
    return primary;
}
/** @param {import('../ports/desktop-control-transfer.mjs').X11Ports} ports @param {string} name @param {Arguments} args @returns {Outcome} */
function x11(ports, name, args) {
    if (name === 'display_window_list') return observed(name, args, ports.windowList(Math.min(args.helperTimeoutMs || 30000, 30000)));
    if (name === 'display_drag') {
        if (!desktopDragValid(args)) return refused('invalid-drag-arguments');
        const normalized = dragArguments(args);
        return observed(name, { ...args, ...normalized }, ports.drag(normalized));
    }
    if (name === 'display_focus_window') {
        const handle = args.handle;
        if (typeof handle !== 'string' || !/^[1-9][0-9]{0,19}$/.test(handle)) return refused('invalid-window-handle');
        const activate = ports.activateWindow(handle, 5000);
        if (!activate.ok) return failed(name, activate.evidence);
        const active = ports.activeWindow(5000);
        if (!active.ok) return failed(name, active.evidence);
        return active.handle === handle ? observed(name, args, active) : refused('window-focus-denied');
    }
    if (name === 'display_move') {
        if (!desktopPointValid(args.x, args.y)) return refused('invalid-pointer-coordinates');
        return observed(name, args, ports.movePointer(Number(args.x), Number(args.y)));
    }
    const { x, y, button = 'left', key, text, direction, amount = 3 } = args;
    if (name === 'display_click') return observed(name, { ...args, button }, ports.click(x, y, button));
    if (name === 'display_double_click') return observed(name, { ...args, button }, ports.doubleClick(x, y, button));
    if (name === 'display_key') return observed(name, args, ports.key(key));
    if (name === 'display_type') return observed(name, args, ports.type(text));
    if (name === 'display_scroll') {
        if (!['up', 'down', 'left', 'right'].includes(direction || '')) return refused(`Unknown scroll direction: ${direction}`);
        return observed(name, { ...args, amount }, ports.scroll(x, y, String(direction), amount));
    }
    if (name === 'display_cursor_position') return observed(name, args, ports.cursorPosition());
    return undefined;
}
const deviceActions = ['device_click', 'device_double_click', 'device_key', 'device_type', 'device_scroll', 'device_drag', 'device_focus_window', 'device_cursor_position', 'device_window_list', 'device_upload', 'device_download'];
/** @template Target,Helper,Upload @param {import('../ports/desktop-control-transfer.mjs').WindowsPorts<Target,Helper,Upload>} ports @param {string} name @param {Arguments} args @returns {Promise<Outcome>} */
async function windows(ports, name, args) {
    if (!deviceActions.includes(name)) return undefined;
    const target = ports.target(args.deviceId);
    if (!target) return undefined;
    if (name === 'device_upload' || name === 'device_download') {
        const helper = ports.workspace(target), label = name === 'device_upload' ? 'upload' : 'download';
        const remote = ports.guestPath(args.remotePath, helper, label);
        if (!remote.ok) return refused(remote.message);
        const local = name === 'device_upload' ? ports.inputPath(args.localPath) : ports.outputPath(args.localPath);
        if (!local.ok) return refused(local.message);
        const normalized = { ...args, localPath: local.path, remotePath: remote.path };
        if (name === 'device_upload') {
            const stage = ports.stageUpload(helper, local.path);
            if (!stage.ok) return refused(stage.message);
            /** @type {import('../domain/desktop-control-transfer.mjs').DesktopResult|{kind:'thrown',error:unknown}} */
            let primary;
            try {
                primary = observed(name, normalized, await ports.upload(target, stage.guestPath, remote.path, args.helperTimeoutMs));
            } catch (error) { primary = { kind: 'thrown', error }; }
            return finalizeStage(name, primary, () => ports.disposeUpload(stage.handle));
        }
        const result = await ports.download(target, remote.path, args.helperTimeoutMs);
        if (!result.ok) return failed(name, result.evidence);
        const output = ports.downloadOutput(result.evidence, remote.path);
        if (!output.ok) return refused('Windows helper download output is missing or unsafe');
        const copied = ports.copyDownload(output.path, local.path);
        if (!copied.ok) return failed(name, copied.evidence);
        return observed(name, normalized, result);
    }
    const { x, y, button = 'left', key, text, direction = 'down', amount = 1 } = args;
    if (name === 'device_click' || name === 'device_double_click') {
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return refused(`${name} requires numeric x and y`);
        const normalized = { ...args, x: Number(x), y: Number(y), button };
        const result = name === 'device_click' ? await ports.click(target, normalized.x, normalized.y, button, args.helperTimeoutMs) : await ports.doubleClick(target, normalized.x, normalized.y, button, args.helperTimeoutMs);
        return observed(name, normalized, result);
    }
    if (name === 'device_key') {
        if (!key) return refused('device_key requires key');
        return observed(name, args, await ports.key(target, key, args.helperTimeoutMs));
    }
    if (name === 'device_type') {
        if (text === undefined || text === null) return refused('device_type requires text');
        return observed(name, { ...args, text: String(text) }, await ports.type(target, String(text), args.helperTimeoutMs));
    }
    if (name === 'device_scroll') {
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return refused('device_scroll requires numeric x and y');
        if (!['up', 'down', 'left', 'right'].includes(direction)) return refused('device_scroll direction must be up, down, left, or right');
        const normalized = { ...args, x: Number(x), y: Number(y), direction, amount: Number(amount) || 1 };
        return observed(name, normalized, await ports.scroll(target, normalized.x, normalized.y, direction, normalized.amount, args.helperTimeoutMs));
    }
    if (name === 'device_drag') {
        if (!desktopDragValid(args)) return refused('invalid-drag-arguments');
        const normalized = dragArguments(args);
        return observed(name, { ...args, ...normalized }, await ports.drag(target, normalized, args.helperTimeoutMs));
    }
    if (name === 'device_focus_window') {
        if (typeof args.handle !== 'string' || !/^[1-9][0-9]{0,18}$/.test(args.handle)) return refused('invalid-window-handle');
        return observed(name, args, await ports.focusWindow(target, args.handle, args.helperTimeoutMs));
    }
    if (name === 'device_cursor_position') {
        if ((x !== undefined || y !== undefined) && !desktopPointValid(x, y)) return refused('invalid-pointer-coordinates');
        return observed(name, args, await ports.cursorPosition(target, x, y, args.helperTimeoutMs));
    }
    return observed(name, args, await ports.windowList(target, args.helperTimeoutMs));
}
/** @template Target,Bridge,Stage @param {import('../ports/desktop-control-transfer.mjs').MacosPorts<Target,Bridge,Stage>} ports @param {string} name @param {Arguments} args @returns {Outcome} */
function macos(ports, name, args) {
    if (!deviceActions.includes(name)) return undefined;
    const target = ports.target(args.deviceId);
    if (!target) return undefined;
    if (name === 'device_upload' || name === 'device_download') {
        const bridge = ports.bridge(target, name);
        if (!bridge.ok) return failed(name, bridge.evidence);
        const remote = ports.guestPath(args.remotePath, name === 'device_upload' ? 'upload' : 'download');
        if (!remote.ok) return refused(remote.message);
        if (name === 'device_upload') {
            const stage = ports.stageInput(args.localPath);
            if (!stage.ok) return refused(stage.message);
            /** @type {import('../domain/desktop-control-transfer.mjs').DesktopResult|{kind:'thrown',error:unknown}} */
            let primary;
            try {
                primary = observed(name, { ...args, localPath: stage.path, remotePath: remote.path }, ports.upload(target, bridge.bridge, stage.stagedPath, remote.path, args.helperTimeoutMs));
            } catch (error) { primary = { kind: 'thrown', error }; }
            return finalizeStage(name, primary, () => ports.disposeInput(stage.handle));
        }
        const stage = ports.stageOutput(args.localPath);
        if (!stage.ok) return refused(stage.message);
        /** @type {import('../domain/desktop-control-transfer.mjs').DesktopResult|{kind:'thrown',error:unknown}} */
        let primary;
        try {
            const result = ports.download(target, bridge.bridge, remote.path, stage.stagedPath, args.helperTimeoutMs);
            if (!result.ok) primary = failed(name, result.evidence);
            else {
                const committed = ports.commitOutput(stage.handle);
                primary = committed.ok
                    ? observed(name, { ...args, localPath: committed.path, remotePath: remote.path }, result)
                    : refused(committed.message);
            }
        } catch (error) { primary = { kind: 'thrown', error }; }
        return finalizeStage(name, primary, () => ports.disposeOutput(stage.handle));
    }
    const { x, y, button = 'left', key, text, direction = 'down', amount = 1 } = args;
    if (name === 'device_click' || name === 'device_double_click') {
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return refused(`${name} requires numeric x and y`);
        const normalized = { ...args, x: Number(x), y: Number(y), button };
        const result = name === 'device_click' ? ports.click(target, normalized.x, normalized.y, button, args.helperTimeoutMs) : ports.doubleClick(target, normalized.x, normalized.y, button, args.helperTimeoutMs);
        return observed(name, normalized, result);
    }
    if (name === 'device_key') {
        if (!ports.supportsKey(key || '')) return refused(`Unsupported macOS key expression: ${key}`);
        return observed(name, args, ports.key(target, String(key), args.helperTimeoutMs));
    }
    if (name === 'device_type') {
        if (text === undefined || text === null) return refused('device_type requires text');
        return observed(name, { ...args, text: String(text) }, ports.type(target, String(text), args.helperTimeoutMs));
    }
    if (name === 'device_scroll') {
        if (!['up', 'down', 'left', 'right'].includes(direction)) return refused('device_scroll direction must be up, down, left, or right');
        const normalized = { ...args, direction, amount: Number(amount) || 1 };
        return observed(name, normalized, ports.scroll(target, direction, normalized.amount, args.helperTimeoutMs));
    }
    if (name === 'device_focus_window') {
        const handle = args.handle;
        if (typeof handle !== 'string' || handle.length > 2048 || !/^macos:[1-9][0-9]{0,9}:[1-9][0-9]{0,15}:[^\r\n]+$/.test(handle)) return refused('window-handle-invalid');
        const result = ports.focusWindow(target, handle, args.helperTimeoutMs);
        if (!result.ok) return failed(name, result.evidence);
        return result.verified ? observed(name, args, result) : refused('window-focus-unverified');
    }
    if (name === 'device_drag') {
        if (!desktopDragValid(args)) return refused('invalid-drag-arguments');
        const normalized = dragArguments(args);
        return observed(name, { ...args, ...normalized }, ports.drag(target, normalized, args.helperTimeoutMs));
    }
    if (name === 'device_cursor_position') {
        const moving = x !== undefined || y !== undefined;
        if (moving && !desktopPointValid(x, y)) return refused('invalid-pointer-coordinates');
        return observed(name, args, moving ? ports.movePointer(target, Number(x), Number(y), args.helperTimeoutMs) : ports.cursorPosition(target, args.helperTimeoutMs));
    }
    return observed(name, args, ports.windowList(target, args.helperTimeoutMs));
}
/**
 * @template Target,Helper,Upload,Bridge,Stage
 * @param {import('../ports/desktop-control-transfer.mjs').DesktopControlTransferPorts<Target,Helper,Upload,Bridge,Stage>} ports
 * @returns {import('../ports/desktop-control-transfer.mjs').DesktopControlTransfer}
 */
export function createDesktopControlTransfer(ports) {
    return {
        async handle(name, args) {
            if (ports.variant === 'x11') return x11(ports, name, args);
            if (ports.variant === 'windows') return windows(ports, name, args);
            return macos(ports, name, args);
        }
    };
}
