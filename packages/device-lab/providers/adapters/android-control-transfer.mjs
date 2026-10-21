import { androidActionPlan as semanticActionPlan, androidOrientationPlan as semanticOrientationPlan } from "../domain/android-control-transfer.mjs";
import { renderStageCleanupFailure } from "./stage-cleanup-result.mjs";

/** @typedef {import('../domain/android-control-transfer.mjs').Point} Point */
/** @typedef {import('../domain/android-control-transfer.mjs').Swipe} Swipe */
/** @typedef {import('../domain/android-control-transfer.mjs').Variant} Variant */
/** @typedef {{orientation:unknown,rotation:'0'|'1'|'2'|'3',provider:'adb'}} OrientationPayload */
/** @typedef {{provider:'adb'} & ({tapped:Point}|{doubleTapped:Point}|{longPressed:Point & {durationMs:unknown}}
 * |{swiped:Swipe}|{dragged:Swipe}|{typed:true}|{key:unknown}|{back:true}|{home:true}|{forward:true}
 * |{recents:true}|{power:true}|{locked:true}|{unlocked:true}|OrientationPayload)} Payload */
/** @typedef {{kind:'tap';point:Point}|{kind:'swipe';swipe:Swipe}|{kind:'text';text:unknown}|{kind:'key';key:unknown}} LegacyIntent */
/** @typedef {{content:Array<{type:string;text?:string}>,isError?:boolean}} AndroidControlNativeResult */

/** @param {import('../ports/android-control-transfer.mjs').CommandReceipt} command
 * @returns {import('../ports/android-control-transfer.mjs').AndroidControlObservation} */
export function androidControlObservation(command) {
    return {ok:command.status === 0,evidence:command};
}

/** @param {import('../domain/android-control-transfer.mjs').Navigation} navigation @returns {number} */
export function androidNavigationKey(navigation) {
    switch (navigation) {
        case 'back': return 4;
        case 'home': return 3;
        case 'forward': return 125;
        case 'recents': return 187;
        case 'power': return 26;
        case 'lock': return 223;
        case 'unlock': return 224;
    }
}

/** @param {import('../domain/android-control-transfer.mjs').Orientation} orientation
 * @returns {'0'|'1'|'2'|'3'} */
export function androidRotationCode(orientation) {
    switch (orientation) {
        case 'portrait': return '0';
        case 'landscape': return '1';
        case 'reverse-portrait': return '2';
        case 'reverse-landscape': return '3';
    }
}

/** @param {import('../domain/android-control-transfer.mjs').ActionCompletion} completion
 * @param {Variant} variant @returns {Payload} */
function actionPayload(completion, variant) {
    switch (completion.kind) {
        case 'tapped': return {tapped:completion.point,provider:'adb'};
        case 'double-tapped': return {doubleTapped:completion.point,provider:'adb'};
        case 'long-pressed': return {longPressed:{...completion.point,durationMs:completion.durationMs},provider:'adb'};
        case 'swiped': return {swiped:completion.swipe,provider:'adb'};
        case 'dragged': return {dragged:completion.swipe,provider:'adb'};
        case 'typed': return {typed:true,provider:'adb'};
        case 'key': return {key:completion.key,provider:'adb'};
        case 'navigation': {
            if (variant === 'physical') return {key:androidNavigationKey(completion.navigation),provider:'adb'};
            switch (completion.navigation) {
                case 'back': return {back:true,provider:'adb'};
                case 'home': return {home:true,provider:'adb'};
                case 'forward': return {forward:true,provider:'adb'};
                case 'recents': return {recents:true,provider:'adb'};
                case 'power': return {power:true,provider:'adb'};
                case 'lock': return {locked:true,provider:'adb'};
                case 'unlock': return {unlocked:true,provider:'adb'};
            }
        }
    }
}

/** @param {import('../ports/android-control-transfer.mjs').AndroidControlCompletion} completion
 * @param {Variant} variant */
function completionPayload(completion, variant) {
    switch (completion.kind) {
        case 'uploaded': return {uploaded:{localPath:completion.localPath,remotePath:completion.remotePath},provider:'adb'};
        case 'downloaded': return {downloaded:{remotePath:completion.remotePath,localPath:completion.localPath},provider:'adb'};
        case 'oriented': return {orientation:completion.orientation,rotation:androidRotationCode(completion.orientation),provider:'adb'};
        default: return actionPayload(completion, variant);
    }
}

/** @param {import('../ports/android-control-transfer.mjs').AndroidControlOutcome|undefined} outcome
 * @param {Variant} variant
 * @param {{jsonResult:(value:object)=>AndroidControlNativeResult,textResult:(ok:boolean,text:string)=>AndroidControlNativeResult,fail:(command:import('../ports/android-control-transfer.mjs').CommandReceipt)=>AndroidControlNativeResult}} renderers
 * @returns {AndroidControlNativeResult|undefined} */
export function presentAndroidControlOutcome(outcome, variant, renderers) {
    if (!outcome) return undefined;
    if (outcome.kind === 'cleanup-failure') {
        const primary = outcome.primary;
        return renderStageCleanupFailure({
            error: 'android-transfer-cleanup-failed',
            primary: primary.kind === 'thrown' ? primary : {
                kind: 'returned', outcome: primary.kind,
                result: presentAndroidControlOutcome(primary, variant, renderers),
            },
            cleanupError: outcome.error,
            ...(primary.kind === 'completed' ? { result: { kind: 'completed', completed: true } } : {}),
        }, renderers.jsonResult);
    }
    if (outcome.kind === 'text') return renderers.textResult(false,outcome.message);
    const command = /** @type {import('../ports/android-control-transfer.mjs').CommandReceipt} */ (outcome.evidence);
    if (outcome.kind === 'command-failure') return renderers.fail(command);
    const payload = completionPayload(outcome.completion,variant);
    return renderers.jsonResult(outcome.completion.kind === 'double-tapped' ? payload
        : {...payload,stdout:command.stdout,stderr:command.stderr,status:command.status});
}

/** Preserve the existing public helper while internal relative imports consume semantic plans.
 * @param {import('../domain/android-control-transfer.mjs').Operation} operation
 * @param {import('../domain/android-control-transfer.mjs').Arguments} input @param {Variant} variant
 * @returns {{ok:false;message:string}|{ok:true;intent:LegacyIntent;payload:Payload;doubleTap:boolean}|undefined} */
export function androidActionPlan(operation, input, variant) {
    const plan = semanticActionPlan(operation,input);
    if (!plan?.ok) return plan;
    const intent = /** @type {LegacyIntent} */ (plan.intent.kind === 'navigation'
        ? {kind:'key',key:androidNavigationKey(plan.intent.navigation)} : plan.intent);
    return {ok:true,intent,payload:actionPayload(plan.completion,variant),doubleTap:plan.doubleTap};
}

/** @param {import('../domain/android-control-transfer.mjs').Operation} operation
 * @param {import('../domain/android-control-transfer.mjs').Arguments} input
 * @returns {{ok:false;message:string}|{ok:true;rotation:'0'|'1'|'2'|'3';payload:OrientationPayload}} */
export function androidOrientationPlan(operation, input) {
    const plan = semanticOrientationPlan(operation,input);
    if (!plan.ok) return plan;
    const rotation = androidRotationCode(plan.orientation);
    return {ok:true,rotation,payload:{orientation:plan.orientation,rotation,provider:'adb'}};
}
