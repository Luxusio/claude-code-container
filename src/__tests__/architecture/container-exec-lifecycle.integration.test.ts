import {spawn} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";

const compositionUrl = new URL("../../../dist/composition/container-exec.js", import.meta.url).href;
const sessionUrl = new URL("../../../dist/session.js", import.meta.url).href;

it("native exec lifecycle acquisition yields to the real owner's timer and enters only after release", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-exec-lifecycle-"));
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
const {withContainerLifecycleLockAsync} = await import(${JSON.stringify(sessionUrl)});
const {createNativeContainerExecPorts} = await import(${JSON.stringify(compositionUrl)});
const ports = createNativeContainerExecPorts({
  ensureDirectories() { throw new Error('unexpected directories callback'); },
  async ensureProjectTools() { throw new Error('unexpected project callback'); },
  assetDirectory: ${JSON.stringify(root)}, trustedCliPath: ${JSON.stringify(join(root, "unused-cli"))}
});
let entered;
const owned = new Promise(resolve => { entered = resolve; });
let release;
const gate = new Promise(resolve => { release = resolve; });
let ownerReleased = false, timerRan = false, waiterEntered = false;
const owner = withContainerLifecycleLockAsync('isolated-exec', async () => {
  entered(); await gate; ownerReleased = true;
});
await owned;
setTimeout(() => {
  if (waiterEntered) throw new Error('waiter entered before owner release');
  timerRan = true; release();
}, 30);
const result = await ports.lifecycleLock('isolated-exec', () => {
  if (!timerRan || !ownerReleased) throw new Error('callback preceded release');
  waiterEntered = true; return 'pinned-id';
});
await owner;
console.log(JSON.stringify({result, timerRan, ownerReleased, waiterEntered}));
`], {cwd: root, env: {...process.env, HOME: root, USERPROFILE: root, CCC_HOME: undefined, CCC_PROFILE: undefined}, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    const completed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("close", resolve);
    });
    const timeout = setTimeout(() => child.kill(), 15000);
    try {
        expect(await completed, stderr).toBe(0);
        expect(JSON.parse(stdout.trim())).toEqual({result: "pinned-id", timerRan: true, ownerReleased: true, waiterEntered: true});
    } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await completed.catch(() => undefined);
        rmSync(root, {recursive: true, force: true});
    }
}, 20000);
