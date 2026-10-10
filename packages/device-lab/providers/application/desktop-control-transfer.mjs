import { desktopPointValid, desktopDragValid, windowsSendKeysExpression, windowsSendKeysLiteralText, macosKeySpec } from '../domain/desktop-control-transfer.mjs';
/** @typedef {import('../domain/desktop-control-transfer.mjs').DesktopArguments} Arguments */
/** @typedef {import('../domain/desktop-control-transfer.mjs').DesktopOutcome} Outcome */
/** @typedef {import('../ports/desktop-control-transfer.mjs').CommandReceipt} Receipt */
/** @param {object} value @returns {Outcome} */
const json = value => ({ kind: 'json', value });
/** @param {string} text @returns {Outcome} */
const refused = text => ({ kind: 'text', ok: false, text });
/** @param {Receipt} receipt @returns {Outcome} */
const failed = receipt => ({ kind: 'command-failure', receipt });
/** @param {string} stdout */
function cursorPosition(stdout) {
    const fields = Object.fromEntries(String(stdout || '').trim().split(/\s+/).map(part => part.split(':')).filter(([key,value]) => key && value !== undefined));
    const x = Number(fields.x), y = Number(fields.y), screen = Number(fields.screen);
    return { x: Number.isFinite(x) ? x : null, y: Number.isFinite(y) ? y : null, screen: Number.isFinite(screen) ? screen : null, window: fields.window || null, raw: String(stdout || '').trim(), provider: 'xdotool' };
}
/** @param {import('../ports/desktop-control-transfer.mjs').X11Ports} ports @param {string} name @param {Arguments} args @returns {Outcome} */
function x11(ports, name, args) {
    if (name === 'display_window_list') {
        const result = ports.windowList(Math.min(args.helperTimeoutMs || 30000, 30000));
        if (result.status !== 0) return failed(result);
        try { return json(ports.parseWindowList(result.stdout)); } catch { return refused('window-list-invalid-result'); }
    }
    if (name === 'display_drag') {
        if (!desktopDragValid(args)) return refused('invalid-drag-arguments');
        const result = ports.drag(Number(args.x1), Number(args.y1), Number(args.x2), Number(args.y2), args.durationMs ?? 700);
        return result.status === 0 ? json({ ok: true }) : failed(result);
    }
    if (name === 'display_focus_window') {
        const handle = args.handle;
        if (typeof handle !== 'string' || !/^[1-9][0-9]{0,19}$/.test(handle)) return refused('invalid-window-handle');
        const activate = ports.boundedCommand(['windowactivate','--sync',handle],5000);
        if (activate.status !== 0) return failed(activate);
        const active = ports.boundedCommand(['getactivewindow'],5000);
        if (active.status !== 0) return failed(active);
        return active.stdout.trim() === handle ? json({ok:true}) : refused('window-focus-denied');
    }
    if (name === 'display_move') {
        if (!desktopPointValid(args.x,args.y)) return refused('invalid-pointer-coordinates');
        const result = ports.command(['mousemove',String(args.x),String(args.y)]);
        return result.status === 0 ? json({ok:true}) : failed(result);
    }
    const { x,y,button = 'left',key,text,direction,amount = 3 } = args;
    if (name === 'display_click' || name === 'display_double_click') {
        const result = ports.command(['mousemove',String(x),String(y),'click',...(name === 'display_double_click' ? ['--repeat','2'] : []),button === 'right' ? '3' : '1']);
        return result.status === 0 ? json({[name === 'display_click' ? 'clicked' : 'doubleClicked']:{x,y,button},provider:'xdotool',stdout:result.stdout,stderr:result.stderr,status:result.status}) : failed(result);
    }
    if (name === 'display_key') {
        const result = ports.command(['key','--',key]);
        return result.status === 0 ? json({key,provider:'xdotool',stdout:result.stdout,stderr:result.stderr,status:result.status}) : failed(result);
    }
    if (name === 'display_type') {
        const result = ports.command(['type','--clearmodifiers','--',text]);
        return result.status === 0 ? json({typed:true,length:String(text || '').length,provider:'xdotool',stdout:result.stdout,stderr:result.stderr,status:result.status}) : failed(result);
    }
    if (name === 'display_scroll') {
        const buttonId = direction === 'up' ? 4 : direction === 'down' ? 5 : direction === 'left' ? 6 : direction === 'right' ? 7 : undefined;
        if (!buttonId) return refused(`Unknown scroll direction: ${direction}`);
        const result = ports.command(['mousemove',String(x),String(y),'click','--repeat',String(amount),String(buttonId)]);
        return result.status === 0 ? json({scrolled:{x,y,direction,amount},provider:'xdotool',stdout:result.stdout,stderr:result.stderr,status:result.status}) : failed(result);
    }
    if (name === 'display_cursor_position') {
        const result = ports.command(['getmouselocation']);
        return result.status === 0 ? json(cursorPosition(result.stdout)) : failed(result);
    }
    return undefined;
}
/** @template Target,Helper,Upload @param {import('../ports/desktop-control-transfer.mjs').WindowsPorts<Target,Helper,Upload>} ports @param {string} name @param {Arguments} args @returns {Promise<Outcome>} */
async function windows(ports,name,args) {
    if (!['device_click','device_double_click','device_key','device_type','device_scroll','device_drag','device_focus_window','device_cursor_position','device_window_list','device_upload','device_download'].includes(name)) return undefined;
    const target = ports.target(args.deviceId);
    if (!target) return undefined;
    if (name === 'device_upload' || name === 'device_download') {
        const helper = ports.workspace(target), label = name === 'device_upload' ? 'upload' : 'download';
        const remote = ports.guestPath(args.remotePath,helper,label);
        if (!remote.ok) return refused(remote.message);
        const local = name === 'device_upload' ? ports.inputPath(args.localPath) : ports.outputPath(args.localPath);
        if (!local.ok) return refused(local.message);
        if (name === 'device_upload') {
            const stage = ports.stageUpload(helper,local.path);
            if (!stage.ok) return refused(stage.message);
            try {
                const result = await ports.request(target,{type:'upload',uploadPath:stage.guestPath,remotePath:remote.path},args.helperTimeoutMs);
                if (result.error !== undefined) return refused(result.error);
                if (!result.response.ok) return refused(result.response.error || 'Windows helper upload failed');
                return json({uploaded:{localPath:local.path,remotePath:remote.path},provider:'windows-helper',response:result.response});
            } finally { ports.disposeUpload(stage.handle); }
        }
        const result = await ports.request(target,{type:'download',remotePath:remote.path},args.helperTimeoutMs);
        if (result.error !== undefined) return refused(result.error);
        if (!result.response.ok) return refused(result.response.error || 'Windows helper download failed');
        const output = ports.downloadOutput(result.helper,result.response,remote.path);
        if (!output.ok) return refused('Windows helper download output is missing or unsafe');
        const copied = ports.copyDownload(output.path,local.path);
        if (!copied.ok) return refused(`Windows helper download output copy failed: ${copied.error}`);
        return json({downloaded:{remotePath:remote.path,localPath:local.path},provider:'windows-helper',response:result.response});
    }
    /** @type {import('../ports/desktop-control-transfer.mjs').HelperRequest} */
    let request;
    const {x,y,button='left',key,text,direction='down',amount=1} = args;
    if (name === 'device_click' || name === 'device_double_click') {
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return refused(`${name} requires numeric x and y`);
        request = {type:name === 'device_click' ? 'click' : 'double_click',x:Number(x),y:Number(y),button};
    } else if (name === 'device_key') {
        if (!key) return refused('device_key requires key');
        request = {type:'key',key,keys:windowsSendKeysExpression(key)};
    } else if (name === 'device_type') {
        if (text === undefined || text === null) return refused('device_type requires text');
        request = {type:'type',text:String(text),keys:windowsSendKeysLiteralText(String(text))};
    } else if (name === 'device_scroll') {
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return refused('device_scroll requires numeric x and y');
        if (!['up','down','left','right'].includes(direction)) return refused('device_scroll direction must be up, down, left, or right');
        request = {type:'scroll',x:Number(x),y:Number(y),direction,amount:Number(amount)||1};
    } else if (name === 'device_drag') {
        if (!desktopDragValid(args)) return refused('invalid-drag-arguments');
        request = {type:'drag',x1:Number(args.x1),y1:Number(args.y1),x2:Number(args.x2),y2:Number(args.y2),durationMs:args.durationMs??700};
    } else if (name === 'device_focus_window') {
        if (typeof args.handle !== 'string' || !/^[1-9][0-9]{0,18}$/.test(args.handle)) return refused('invalid-window-handle');
        request = {type:'focus_window',handle:args.handle};
    } else if (name === 'device_cursor_position') {
        const moving = x !== undefined || y !== undefined;
        if (moving && !desktopPointValid(x,y)) return refused('invalid-pointer-coordinates');
        request = moving ? {type:'cursor_position',x,y} : {type:'cursor_position'};
    } else request = {type:'window_list'};
    const result = await ports.request(target,request,args.helperTimeoutMs);
    if (result.error !== undefined) {
        if (name === 'device_cursor_position' && result.helperDiagnostic) return json({ok:false,error:result.helperDiagnostic.stage === 'response-timeout' ? 'windows-sandbox-helper-timeout' : 'windows-sandbox-helper-failed',helperDiagnostic:result.helperDiagnostic});
        return refused(result.error);
    }
    const response = result.response;
    if (!response.ok) {
        if (name === 'device_cursor_position') return json({ok:false,error:'windows-sandbox-helper-response-rejected',helperDiagnostic:{stage:'response-rejected',readyMarkerPresent:ports.readyMarkerPresent(result.helper)}});
        const label = name === 'device_click' ? 'click' : name === 'device_double_click' ? 'double_click' : name === 'device_key' ? 'key' : name === 'device_type' ? 'type' : name === 'device_scroll' ? 'scroll' : name === 'device_window_list' ? 'window list' : undefined;
        return refused(response.error || (label ? `Windows helper ${label} failed` : 'desktop-control-failed'));
    }
    if (request.type === 'drag' || request.type === 'focus_window') return json({ok:true});
    if (request.type === 'click' || request.type === 'double_click') return json({provider:'windows-helper',[request.type === 'click' ? 'clicked' : 'doubleClicked']:response.doubleClicked || response.clicked || {x:request.x,y:request.y,button},response});
    if (request.type === 'key') return json({provider:'windows-helper',key:response.key || {key:request.key,keys:request.keys},response});
    if (request.type === 'type') return json({provider:'windows-helper',typed:response.typed || {text:request.text,keys:request.keys},response});
    if (request.type === 'scroll') return json({provider:'windows-helper',scrolled:response.scrolled || {x:request.x,y:request.y,direction,amount:request.amount},response});
    if (request.type === 'cursor_position') return json({provider:'windows-helper',cursor:response.cursor || null,response});
    return json({provider:response.provider || 'windows-process-main-window',windows:Array.isArray(response.windows)?response.windows:[],response});
}
/** @template Target,Bridge,Input,Output @param {import('../ports/desktop-control-transfer.mjs').MacosPorts<Target,Bridge,Input,Output>} ports @param {string} name @param {Arguments} args @returns {Outcome} */
function macos(ports,name,args) {
    if (!['device_click','device_double_click','device_key','device_type','device_scroll','device_drag','device_focus_window','device_cursor_position','device_window_list','device_upload','device_download'].includes(name)) return undefined;
    const target = ports.target(args.deviceId);
    if (!target) return undefined;
    if (name === 'device_upload' || name === 'device_download') {
        const bridge = ports.bridge(target,name);
        if (!bridge.ok) return {kind:'native',value:bridge.result};
        const remote = ports.guestPath(args.remotePath,name === 'device_upload' ? 'upload' : 'download');
        if (!remote.ok) return refused(remote.message);
        if (name === 'device_upload') {
            const stage = ports.stageInput(args.localPath);
            if (!stage.ok) return refused(stage.message);
            try {
                const result = ports.upload(target,bridge.bridge,stage.stagedPath,remote.path,args.helperTimeoutMs);
                return result.status === 0 ? json({uploaded:{localPath:stage.path,remotePath:remote.path},stdout:result.stdout,stderr:result.stderr,provider:'scp'}) : failed(result);
            } finally { ports.disposeInput(stage.handle); }
        }
        const stage = ports.stageOutput(args.localPath);
        if (!stage.ok) return refused(stage.message);
        try {
            const result = ports.download(target,bridge.bridge,remote.path,stage.stagedPath,args.helperTimeoutMs);
            if (result.status !== 0) return failed(result);
            const committed = ports.commitOutput(stage.handle);
            if (!committed.ok) return refused(committed.message);
            return json({downloaded:{remotePath:remote.path,localPath:committed.path},stdout:result.stdout,stderr:result.stderr,provider:'scp'});
        } finally { ports.disposeOutput(stage.handle); }
    }
    /** @type {'click'|'double_click'|'key'|'type'|'scroll'|'drag'|'focus_window'|'move'|'cursor_position'|'window_list'} */
    let operation;
    /** @type {string[]} */
    let argv;
    const {x,y,button='left',key,text,direction='down',amount=1} = args;
    const spec = name === 'device_key' ? macosKeySpec(key) : null;
    if (name === 'device_click' || name === 'device_double_click') {
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return refused(`${name} requires numeric x and y`);
        operation = name === 'device_click' ? 'click' : 'double_click';
        argv = [String(Number(x)),String(Number(y)),button];
    } else if (name === 'device_key') {
        if (!spec) return refused(`Unsupported macOS key expression: ${key}`);
        operation = 'key'; argv = [String(spec.keyCode),spec.modifiers.join(',')];
    } else if (name === 'device_type') {
        if (text === undefined || text === null) return refused('device_type requires text');
        operation = 'type'; argv = [String(text)];
    } else if (name === 'device_scroll') {
        if (!['up','down','left','right'].includes(direction)) return refused('device_scroll direction must be up, down, left, or right');
        operation = 'scroll'; argv = [direction,String(Number(amount)||1)];
    } else if (name === 'device_focus_window') {
        const handle = args.handle;
        if (typeof handle !== 'string' || handle.length > 2048 || !/^macos:[1-9][0-9]{0,9}:[1-9][0-9]{0,15}:[^\r\n]+$/.test(handle)) return refused('window-handle-invalid');
        operation = 'focus_window'; argv = [handle];
    } else if (name === 'device_drag') {
        if (!desktopDragValid(args)) return refused('invalid-drag-arguments');
        operation = 'drag'; argv = [args.x1,args.y1,args.x2,args.y2,args.durationMs??700].map(String);
    } else if (name === 'device_cursor_position') {
        const moving = x !== undefined || y !== undefined;
        if (moving && !desktopPointValid(x,y)) return refused('invalid-pointer-coordinates');
        operation = moving ? 'move' : 'cursor_position'; argv = moving ? [String(x),String(y)] : [];
    } else { operation = 'window_list'; argv = []; }
    const helper = ports.helper(target,operation,argv,args.helperTimeoutMs);
    if (helper.error !== undefined) return {kind:'native',value:helper.error};
    const result = helper.result;
    if (result.status !== 0) return failed(result);
    if (operation === 'drag' || operation === 'move') return json({ok:true});
    if (operation === 'key') return json({provider:'ssh-macos-helper',remoteScriptPath:helper.remoteScriptPath,key:spec,stdout:result.stdout,stderr:result.stderr,status:result.status});
    if (operation === 'type') return json({provider:'ssh-macos-helper',remoteScriptPath:helper.remoteScriptPath,typed:{text:String(text)},stdout:result.stdout,stderr:result.stderr,status:result.status});
    const payload = ports.parseHelper(result.stdout);
    if (operation === 'focus_window') return payload?.ok === true ? json({ok:true}) : refused('window-focus-unverified');
    if (operation === 'click' || operation === 'double_click') return json({provider:'ssh-macos-helper',remoteScriptPath:helper.remoteScriptPath,[operation === 'click' ? 'clicked' : 'doubleClicked']:payload?.doubleClicked || payload?.clicked || {x:Number(x),y:Number(y),button},stdout:result.stdout,stderr:result.stderr,status:result.status});
    if (operation === 'scroll') return json({provider:'ssh-macos-helper',remoteScriptPath:helper.remoteScriptPath,scrolled:payload?.scrolled || {direction,amount:Number(amount)||1},stdout:result.stdout,stderr:result.stderr,status:result.status});
    if (operation === 'cursor_position') return json({provider:'ssh-macos-helper',remoteScriptPath:helper.remoteScriptPath,cursor:payload?.cursor || null,stdout:result.stdout,stderr:result.stderr,status:result.status});
    return json({provider:payload?.provider || 'macos-system-events',remoteScriptPath:helper.remoteScriptPath,windows:Array.isArray(payload?.windows)?payload.windows:[],response:payload,stdout:result.stdout,stderr:result.stderr,status:result.status});
}
/**
 * @template Target,Helper,Upload,Bridge,Input,Output
 * @param {import('../ports/desktop-control-transfer.mjs').DesktopControlTransferPorts<Target,Helper,Upload,Bridge,Input,Output>} ports
 * @returns {import('../ports/desktop-control-transfer.mjs').DesktopControlTransfer}
 */
export function createDesktopControlTransfer(ports) {
    return {
        async handle(name,args) {
            if (ports.variant === 'x11') return x11(ports,name,args);
            if (ports.variant === 'windows') return windows(ports,name,args);
            return macos(ports,name,args);
        }
    };
}
