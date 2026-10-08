import { spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { hashPath, getProjectId, prompt, IMAGE_NAME, COMMON_IGNORE_DIRS, collectForwardedEnv, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE } from "../utils.js";
import { getContainerName } from "../docker.js";
import { legacyRemoteConfigDir, readCccConfig, updateCccConfig } from "../home-layout.js";
import { createSessionLock, removeSessionLock, withContainerLifecycleLock, withContainerLifecycleLockAsync } from "../session.js";
import { remoteContainerStartScript, remoteSessionReservationShell, remoteRefreshSessionShell, remoteReleaseSessionShell, remoteStopShell } from "./remote-shell.js";
import type { RemoteServicesPorts } from "../ports/remote-services.js";

// Retain the native call intrinsic across message getter evaluation.
const invokeCaptured = Reflect.apply;

export function getProjectHash(projectPath: string): string { return hashPath(resolve(projectPath)); }
export function getMutagenSessionName(projectPath: string): string { return `ccc-${getProjectId(projectPath)}`; }

/** Each closure reads current trusted native authority at the original call. */
export function createNativeRemoteServicesPorts(): RemoteServicesPorts {
    return {
        resolveProjectPath: path => resolve(path), getProjectId: path => getProjectId(path),
        getProjectHash, getMutagenSessionName, getContainerName(path, profile) { return arguments.length === 1 ? getContainerName(path) : getContainerName(path, profile); },
        captureHashPath: () => ((captured: typeof hashPath) => (value: string) => captured(value))(hashPath), newReservationToken: () => randomBytes(16).toString("hex"),
        observeTool: tool => spawnSync(tool, ["version"], { encoding: "utf-8" }),
        observeHostReachability: host => spawnSync("ping", ["-c", "1", "-W", "1", host], { encoding: "utf-8" }),
        observeSync: name => spawnSync("mutagen", ["sync", "list", name], { encoding: "utf-8" }),
        startSyncDaemon: () => spawnSync("mutagen", ["daemon", "start"], { stdio: "ignore" }),
        terminateSync: name => spawnSync("mutagen", ["sync", "terminate", name], { stdio: "inherit" }),
        resumeSync: name => spawnSync("mutagen", ["sync", "resume", name], { stdio: "inherit" }),
        createSync: args => spawnSync("mutagen", args, { stdio: "inherit" }),
        pauseSync: name => spawnSync("mutagen", ["sync", "pause", name], { stdio: "inherit" }),
        readCommonIgnoreDirs: () => COMMON_IGNORE_DIRS,
        readSettings: () => readCccConfig(),
        captureLegacyConfigReader: hash => {
            const file = join(legacyRemoteConfigDir(), `${hash}.json`);
            return { exists: () => existsSync(file), readText: () => readFileSync(file, "utf-8") };
        },
        updateSettings: callback => { updateCccConfig(settings => { callback(settings); }); return undefined; },
        readUser: () => process.env.USER,
        prompt: (question, confirmation) => confirmation === undefined ? prompt(question) : prompt(question, confirmation),
        captureLog: () => { const receiver = console; const emit = receiver.log; return message => { invokeCaptured(emit, receiver, [message]); return undefined; }; },
        captureError: () => { const receiver = console; const emit = receiver.error; return message => { invokeCaptured(emit, receiver, [message]); return undefined; }; },
        captureProgress: () => { const receiver = process.stdout; const emit = receiver.write; return message => { invokeCaptured(emit, receiver, [message]); return undefined; }; },
        observeRemoteImage: config => {
            const command = `docker images -q ${IMAGE_NAME}`;
            return spawnSync("ssh", [`${config.user}@${config.host}`, command], { encoding: "utf-8", timeout: 10000 });
        },
        buildContainerStartShell: (path, profile) => remoteContainerStartScript(path, profile),
        buildReservationShell: (name, token, lease, command, pin) => remoteSessionReservationShell(name, token, lease, command, pin),
        buildRefreshShell: (name, token, lease, pin, expectedId) => remoteRefreshSessionShell(name, token, lease, pin, expectedId),
        buildReleaseShell: (name, token) => remoteReleaseSessionShell(name, token),
        buildStopShell: (name, token, expectedId) => remoteStopShell(name, token, expectedId),
        runReservation: (config, buildBody) => spawnSync("ssh", [`${config.user}@${config.host}`, buildBody()], { encoding: "utf-8", timeout: 60000 }),
        prepareRemoteProject: (config, id, projectId) => {
            const command = `docker exec ${id} mkdir -p /project/${projectId}`;
            return spawnSync("ssh", [`${config.user}@${config.host}`, command], { encoding: "utf-8" });
        },
        runRefresh: (config, buildBody) => spawnSync("ssh", [`${config.user}@${config.host}`, buildBody()], { encoding: "utf-8", timeout: 10000 }),
        runRelease: (config, buildBody) => spawnSync("ssh", [`${config.user}@${config.host}`, buildBody()], { encoding: "utf-8", timeout: 10000 }),
        runStop: (config, buildBody) => spawnSync("ssh", [`${config.user}@${config.host}`, buildBody()], { encoding: "utf-8", timeout: 60000 }),
        createSessionLock: prefix => createSessionLock(prefix),
        removeSessionLock: file => { removeSessionLock(file); return undefined; },
        withLifecycleLock: (prefix, operation) => withContainerLifecycleLock(prefix, operation),
        withLifecycleLockAsync: (prefix, operation) => withContainerLifecycleLockAsync(prefix, operation),
        startHeartbeat: (callback, milliseconds) => {
            const timer = setInterval(callback, milliseconds);
            return { unref: () => { timer.unref(); return undefined; }, cancel: () => { clearInterval(timer); return undefined; } };
        },
        onceSignal: (signal, callback) => { process.once(signal, callback); return undefined; },
        removeSignalListener: (signal, callback) => { process.removeListener(signal, callback); return undefined; },
        resignalSelf: signal => process.kill(process.pid, signal), exit: code => process.exit(code),
        collectCurrentForwardedEnv: () => collectForwardedEnv(process.env),
        readContainerEnvKey: () => CONTAINER_ENV_KEY, readContainerEnvValue: () => CONTAINER_ENV_VALUE,
        encodeProgram: program => Buffer.from(program, "utf8").toString("base64"),
        startInteractiveSsh: (config, command) => {
            const child = spawn("ssh", ["-t", `${config.user}@${config.host}`, command], { stdio: "inherit" });
            return {
                onClose: callback => { child.on("close", callback); return undefined; },
                onError: callback => { child.on("error", callback); return undefined; },
                kill: signal => child.kill(signal),
            };
        },
        now: () => Date.now(), sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    };
}
