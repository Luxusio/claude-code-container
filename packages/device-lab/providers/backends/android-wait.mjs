import { runWithTimeout } from "../commands.mjs";
import { createWaitBudget } from "../wait-budget.mjs";
import { createAndroidAccessWait } from "../application/android-device-access.mjs";

/** @type {import('../ports/android-device-access.mjs').AndroidAccessWaitPorts<{adb:string,targetArgs:string[]}>} */
const waitPorts = {
    budget: (timeoutMs, intervalMs) => createWaitBudget(timeoutMs, intervalMs),
    executeTimed: (target, args, timeoutMs) => runWithTimeout(target.adb, [...target.targetArgs, ...args], timeoutMs),
};
const androidWait = createAndroidAccessWait(waitPorts);

export function waitForAndroidText(adb, targetArgs, remotePath, text, timeoutMs, intervalMs) {
    return androidWait.text({ adb, targetArgs }, remotePath, text, timeoutMs, intervalMs);
}
export function waitForAndroidApp(adb, targetArgs, packageName, timeoutMs, intervalMs) {
    return androidWait.app({ adb, targetArgs }, packageName, timeoutMs, intervalMs);
}
