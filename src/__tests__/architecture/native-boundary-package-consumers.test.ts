import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const androidModule = "@ccc/device-lab/providers/domain/android-control-transfer.mjs";
const observationModule = "@ccc/device-lab/providers/domain/device-observation.mjs";
const require = createRequire(import.meta.url);
const roots: string[] = [];

// Ordinary tests resolve the installed workspace package. Emitted/package QA
// supplies its genuine artifact root explicitly; a bad override never falls back.
function packageRoot() {
    const configured = process.env.CCC_NATIVE_BOUNDARY_PACKAGE_ROOT;
    let directory = configured === undefined ? dirname(require.resolve(androidModule)) : realpathSync(configured);
    while (true) {
        const manifest = join(directory, "package.json");
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@ccc/device-lab") return directory;
        if (configured !== undefined || dirname(directory) === directory) throw new Error("Expected an actual @ccc/device-lab package root");
        directory = dirname(directory);
    }
}

function consumerDirectory() {
    const root = mkdtempSync(join(tmpdir(), "ccc-native-boundary-package-"));
    roots.push(root);
    mkdirSync(join(root, "node_modules", "@ccc"), { recursive: true });
    symlinkSync(packageRoot(), join(root, "node_modules", "@ccc", "device-lab"), process.platform === "win32" ? "junction" : "dir");
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy native helper package consumers", () => {
    it("resolves both public routes in plain Node and preserves their original helper results", () => {
        const root = consumerDirectory();
        const program = join(root, "consumer.mjs");
        writeFileSync(program, `
import assert from 'node:assert/strict';
import * as android from '${androidModule}';
import * as observation from '${observationModule}';
assert.deepEqual(android.androidActionPlan('mobile_key', {keyCode: 0, key: 'fallback'}, 'physical'),
    {ok: true, intent: {kind: 'key', key: 0}, payload: {key: 0, provider: 'adb'}, doubleTap: false});
assert.deepEqual(android.androidActionPlan('mobile_key', {key: 'CUSTOM_KEY'}, 'emulator'),
    {ok: true, intent: {kind: 'key', key: 'CUSTOM_KEY'}, payload: {key: 'CUSTOM_KEY', provider: 'adb'}, doubleTap: false});
assert.deepEqual(android.androidActionPlan('mobile_key', {key: ''}, 'emulator'),
    {ok: false, message: 'mobile_key requires key or keyCode'});
assert.deepEqual(android.androidActionPlan('mobile_back', {}, 'emulator'),
    {ok: true, intent: {kind: 'key', key: 4}, payload: {back: true, provider: 'adb'}, doubleTap: false});
assert.deepEqual(android.androidActionPlan('mobile_back', {}, 'physical'),
    {ok: true, intent: {kind: 'key', key: 4}, payload: {key: 4, provider: 'adb'}, doubleTap: false});
assert.deepEqual(android.androidActionPlan('mobile_double_tap', {x: 3, y: 7}, 'emulator'),
    {ok: true, intent: {kind: 'tap', point: {x: 3, y: 7}}, payload: {doubleTapped: {x: 3, y: 7}, provider: 'adb'}, doubleTap: true});
assert.equal(android.androidActionPlan('device_upload', {}, 'physical'), undefined);
for (const [orientation, rotation] of [['portrait', '0'], ['landscape', '1'], ['reverse-portrait', '2'], ['reverse-landscape', '3']]) {
    assert.deepEqual(android.androidOrientationPlan('mobile_set_orientation', {orientation}),
        {ok: true, rotation, payload: {orientation, rotation, provider: 'adb'}});
}
assert.deepEqual(android.androidOrientationPlan('mobile_rotate_right', {}),
    {ok: true, rotation: '3', payload: {orientation: 'reverse-landscape', rotation: '3', provider: 'adb'}});
assert.deepEqual(android.androidOrientationPlan('mobile_set_orientation', {orientation: 'sideways'}),
    {ok: false, message: 'Unsupported Android orientation: sideways'});

assert.deepEqual(observation.observationMacosStartArgs('tart', 'instance', {softnet: true, headless: true}),
    ['run', '--with-softnet', '--no-graphics', 'instance']);
assert.deepEqual(observation.observationMacosStartArgs('tart', 'instance'), ['run', 'instance']);
assert.deepEqual(observation.observationMacosStartArgs('vz', 'instance', {headless: true}), ['start', 'instance']);
const paths = {workspaceDir: '/owned/workspace', toolsDir: '/owned/tools', hostHelperScript: '/owned/helper'};
const ssh = {host: 'guest', user: 'tester', password: 'private'};
const publicSsh = {host: 'guest', user: 'tester', passwordConfigured: true};
const device = {id: 'vm', provider: 'auto', memoryMb: 2048, cpus: 2, softnet: true, headless: true, ssh};
const expectedHelper = {...paths, remoteScriptPath: '/tmp/ccc-vm-guest-helper.sh', bridge: 'ssh', ssh: publicSsh,
    status: 'ssh-configured', provisioning: null,
    requiredFor: ['device_focus_window', 'device_drag', 'device_exec', 'device_screenshot', 'device_click',
        'device_double_click', 'device_key', 'device_type', 'device_scroll', 'device_cursor_position',
        'device_window_list', 'device_accessibility_snapshot', 'device_record_video_start', 'device_record_video_stop',
        'device_upload', 'device_download']};
assert.deepEqual(observation.observationMacosPlan(device,
    {hostSupported: true, providers: [{name: 'tart', command: '/bin/tart'}, {name: 'vz', command: '/bin/vz'}], missing: []}, 'owner', paths), {
    requestedProvider: 'auto', selectedProvider: 'tart', providerCommand: '/bin/tart', providerInstance: 'ccc-owner-vm',
    workspaceDir: paths.workspaceDir, image: null, memoryMb: 2048, cpus: 2, helper: expectedHelper,
    available: true, missing: [],
    startCommand: {command: '/bin/tart', args: ['run', '--with-softnet', '--no-graphics', 'ccc-owner-vm']},
    stopCommand: {command: '/bin/tart', args: ['stop', 'ccc-owner-vm']},
    deleteCommand: {command: '/bin/tart', args: ['delete', 'ccc-owner-vm']},
    implemented: ['base-image-create', 'base-image-clone', 'snapshot-clone', 'snapshot-restore', 'snapshot-delete', 'provider-delete'],
    deferred: []
});
const missing = observation.observationMacosPlan({...device, provider: 'vz'},
    {hostSupported: true, providers: [], missing: ['host', 'macos-vm-provider:vz']}, 'owner', paths);
assert.deepEqual([missing.available, missing.selectedProvider, missing.providerCommand, missing.missing,
    missing.startCommand, missing.stopCommand, missing.deleteCommand],
    [false, null, null, ['host', 'macos-vm-provider:vz'], null, null, null]);
const noCommand = observation.observationMacosPlan({...device, provider: 'vz', providerInstance: 'saved'},
    {hostSupported: true, providers: [{name: 'vz', command: ''}], missing: []}, 'owner', paths);
assert.deepEqual([noCommand.available, noCommand.selectedProvider, noCommand.providerCommand, noCommand.providerInstance,
    noCommand.startCommand, noCommand.stopCommand, noCommand.deleteCommand], [false, 'vz', null, 'saved', null, null, null]);
assert.deepEqual(observation.publicObservationSsh(ssh), publicSsh);
assert.equal(observation.publicObservationSsh(null), null);
assert.deepEqual(observation.publicObservationMacosDevice(device), {...device, ssh: publicSsh});
assert.equal(ssh.password, 'private');
assert.deepEqual(observation.observationMacosHelper(device, paths), expectedHelper);
assert.deepEqual(observation.publicObservationAndroidDevice({id: 'phone', avdRoot: '/private', status: 'running'}), {id: 'phone', status: 'running'});
assert.equal(observation.observationAvailability(false), 'missing-prerequisites');
assert.equal(observation.observationAvailability(true), 'available');
assert.equal(observation.simulatorObservationState('BOOTED'), 'booted');
assert.equal(observation.simulatorObservationState(undefined), 'unknown');
const target = {id: 'phone', backend: 'android-device', physical: true, serial: 'serial', status: 'running'};
const lease = {hardwareId: 'serial', ownerId: 'owner', expiresAt: '2030-01-01T00:00:00.000Z'};
assert.equal(observation.observationRuntimeState(target), 'running');
assert.deepEqual(observation.observationReadiness(target, 'running'), {state: 'ready'});
assert.equal(observation.observationHardwareId(target), 'serial');
assert.equal(observation.observationOwnedLease(target, [lease], 'owner'), lease);
const leaseState = {state: 'owned', hardwareId: 'serial', ownerId: 'owner', deviceId: 'phone', expiresAt: lease.expiresAt, heartbeatAt: null};
assert.deepEqual(observation.observationLeaseState(target, lease, 0), leaseState);
const sessionState = {state: 'none', appium: null, recording: null, helper: null};
assert.deepEqual(observation.observationSessionState(target), sessionState);
assert.deepEqual(observation.observationTargetStatus(target, leaseState), {targetKind: 'physical-device', creatable: false,
    attachable: false, runtimeState: 'running', readiness: {state: 'ready'}, leaseState, sessionState});
process.stdout.write('legacy package helpers passed');
`);
        const child = spawnSync(process.execPath, [program], {
            cwd: root, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
            env: { HOME: root, USERPROFILE: root, PATH: "", TMPDIR: root, TEMP: root, TMP: root },
        });
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status, child.stderr).toBe(0);
        expect(child.stderr).toBe("");
        expect(child.stdout).toBe("legacy package helpers passed");
    });

    it("typechecks the same bare package routes and legacy shapes with strict library checking", () => {
        const root = consumerDirectory();
        writeFileSync(join(root, "consumer.mts"), `
import {androidActionPlan, androidOrientationPlan} from '${androidModule}';
import * as observation from '${observationModule}';
const action = androidActionPlan('mobile_back', {}, 'physical');
if (action?.ok) {
    const provider: 'adb' = action.payload.provider;
    const doubleTap: boolean = action.doubleTap;
    if (action.intent.kind === 'key') { const key: unknown = action.intent.key; void key; }
    void [provider, doubleTap];
}
const orientation = androidOrientationPlan('mobile_set_orientation', {orientation: 'portrait'});
if (orientation.ok) {
    const rotation: '0' | '1' | '2' | '3' = orientation.rotation;
    const payloadRotation: typeof rotation = orientation.payload.rotation;
    const provider: 'adb' = orientation.payload.provider;
    void [rotation, payloadRotation, provider];
}
const device = {id: 'vm', ssh: {host: 'guest', user: 'tester', password: 'private'}};
const paths = {workspaceDir: '/owned/workspace', toolsDir: '/owned/tools', hostHelperScript: '/owned/helper'};
const plan = observation.observationMacosPlan(device,
    {hostSupported: true, providers: [{name: 'tart', command: '/bin/tart'}], missing: []}, 'owner', paths);
const args: string[] = observation.observationMacosStartArgs('tart', 'instance', {headless: true, softnet: true});
const command: string | null = plan.providerCommand;
const start: {command: string; args: string[]} | null = plan.startCommand;
const stop: typeof start = plan.stopCommand;
const remove: typeof start = plan.deleteCommand;
const available: boolean = plan.available;
const missing: string[] = plan.missing;
const helper = observation.observationMacosHelper(device, paths);
const passwordConfigured: unknown = observation.publicObservationSsh(device.ssh)?.passwordConfigured;
const publicDevice = observation.publicObservationMacosDevice(device);
const androidDevice = observation.publicObservationAndroidDevice({id: 'phone', avdRoot: '/private'});
const target = {id: 'phone', backend: 'android-device', physical: true, serial: 'serial', status: 'running'};
const state = observation.observationRuntimeState(target);
const readiness = observation.observationReadiness(target, state);
const hardware: string | null = observation.observationHardwareId(target);
const lease = observation.observationOwnedLease(target, [{hardwareId: 'serial', ownerId: 'owner'}], 'owner');
const leaseState = observation.observationLeaseState(target, lease, 0);
const sessionState = observation.observationSessionState(target);
const status = observation.observationTargetStatus(target, leaseState);
const availability: string = observation.observationAvailability(true);
const simulator: string = observation.simulatorObservationState('Booted');
void [args, command, start, stop, remove, available, missing, helper, passwordConfigured, publicDevice,
    androidDevice, readiness, hardware, sessionState, status, availability, simulator];
`);
        writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: {
                target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true,
                strict: true, noUnusedLocals: true, noUnusedParameters: true, skipLibCheck: false,
                allowJs: true, checkJs: true, maxNodeModuleJsDepth: 20, types: [],
            },
            files: ["consumer.mts"],
        }));
        const child = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--project", join(root, "tsconfig.json"), "--pretty", "false"], {
            cwd: root, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
            env: { HOME: root, USERPROFILE: root, PATH: "", TMPDIR: root, TEMP: root, TMP: root },
        });
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status, child.stdout + child.stderr).toBe(0);
        expect(child.stdout + child.stderr).toBe("");
    }, 45000);
});
