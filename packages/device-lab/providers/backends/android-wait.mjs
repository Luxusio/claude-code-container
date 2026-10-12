import { run, runWithTimeout } from "../commands.mjs";
import { createWaitBudget } from "../wait-budget.mjs";
import { createAndroidAccessWait } from "../application/android-device-access.mjs";

/** Timed observations diagnose process errors/signals as well as exit status. */
function waitDiagnostic(result) {
    const cause = result.error?.message || (result.signal ? `signal ${result.signal}` : "");
    return cause ? { ...result, stderr: `${cause}${result.stderr ? `: ${result.stderr}` : ""}` } : result;
}
function commandSucceeded(result, timed) {
    return result.status === 0 && (!timed || !result.error && !result.signal);
}
/** @returns {import('../ports/android-device-access.mjs').AndroidAccessObservation<undefined>} */
export function dumpAndroidUi(adb, targetArgs, remotePath, timeoutMs) {
    const args = [...targetArgs, "shell", "uiautomator", "dump", remotePath];
    const result = timeoutMs === undefined ? run(adb,args) : runWithTimeout(adb,args,timeoutMs);
    return commandSucceeded(result, timeoutMs !== undefined)
        ? {ok:true,value:undefined,diagnostic:result}
        : {ok:false,diagnostic:timeoutMs === undefined ? result : waitDiagnostic(result)};
}
/** @returns {import('../ports/android-device-access.mjs').AndroidAccessObservation<string>} */
export function readAndroidUi(adb, targetArgs, remotePath, mode, timeoutMs) {
    const args = [...targetArgs, mode === "primary" ? "exec-out" : "shell", "cat", remotePath];
    const result = timeoutMs === undefined ? run(adb,args) : runWithTimeout(adb,args,timeoutMs);
    return commandSucceeded(result, timeoutMs !== undefined)
        ? {ok:true,value:result.stdout || "",diagnostic:result}
        : {ok:false,diagnostic:timeoutMs === undefined ? result : waitDiagnostic(result)};
}
/** @returns {import('../ports/android-device-access.mjs').AndroidAccessObservation<import('../ports/android-device-access.mjs').AndroidAppObservation>} */
export function observeAndroidApp(adb, targetArgs, packageName, timeoutMs) {
    const result = runWithTimeout(adb,[...targetArgs,"shell","pidof",packageName],timeoutMs);
    const absent = result.status === 1 && !result.stdout && !result.stderr && !result.error && !result.signal;
    if (!commandSucceeded(result,true) && !absent) return {ok:false,diagnostic:waitDiagnostic(result)};
    const pid = (result.stdout || "").trim();
    return {ok:true,value:{running:Boolean(pid),...(pid ? {pid}:{}),diagnostic:result}};
}

/** @type {import('../ports/android-device-access.mjs').AndroidAccessWaitPorts<{adb:string,targetArgs:string[]}>} */
const waitPorts = {
    budget: (timeoutMs, intervalMs) => createWaitBudget(timeoutMs, intervalMs),
    dumpUi: (target,path,timeoutMs) => dumpAndroidUi(target.adb,target.targetArgs,path,timeoutMs),
    readUi: (target,path,mode,timeoutMs) => readAndroidUi(target.adb,target.targetArgs,path,mode,timeoutMs),
    observeApp: (target,packageName,timeoutMs) => observeAndroidApp(target.adb,target.targetArgs,packageName,timeoutMs),
};
const androidWait = createAndroidAccessWait(waitPorts);

/** Retain the native wait exports' historical receipt envelopes outward. */
export function presentAndroidTextWait(result) {
    if (result.kind === "native-failure") return {error:result.diagnostic};
    if (result.kind === "deadline") return {error:{status:null,stderr:"Android wait deadline exhausted before observing UI"}};
    return result;
}
export function presentAndroidAppWait(result) {
    if (result.kind === "native-failure") return {error:result.diagnostic};
    if (result.kind === "deadline") return {error:{status:null,stderr:"Android wait deadline exhausted before observing the app"}};
    const command = result.diagnostic;
    return result.running
        ? {running:true,pid:result.pid,stdout:command.stdout || "",stderr:command.stderr,status:command.status}
        : {running:false,timeoutMs:result.timeoutMs,stdout:command.stdout || "",stderr:command.stderr,status:0,nativeStatus:command.status};
}
export async function waitForAndroidText(adb, targetArgs, remotePath, text, timeoutMs, intervalMs) {
    return presentAndroidTextWait(await androidWait.text({ adb, targetArgs }, remotePath, text, timeoutMs, intervalMs));
}
export async function waitForAndroidApp(adb, targetArgs, packageName, timeoutMs, intervalMs) {
    return presentAndroidAppWait(await androidWait.app({ adb, targetArgs }, packageName, timeoutMs, intervalMs));
}
