import { it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
const state = vi.hoisted(() => ({ trace: [] as unknown[][], fs: {} as Record<string, unknown>, path: {} as Record<string, unknown>, identity: {} as Record<string, unknown>, runtime: {} as Record<string, unknown>, info: {} as Record<string, unknown>, present: new Set<string>() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawnSync: () => { throw new Error('fixture process forbidden'); } }));
vi.mock('os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => '/fixture/home' }));
vi.mock('fs', async original => {
    const exports = { ...await original<typeof import('node:fs')>(), existsSync: (path: string) => { state.trace.push(['exists', path]); return state.present.has(path); } }; state.fs = exports; return exports;
});
vi.mock('path', async original => {
    const actual = await original<typeof import('node:path')>();
    const exports = { ...actual, join: (...parts: string[]) => { state.trace.push(['join', ...parts]); return actual.join(...parts); } }; state.path = exports; return exports;
});
vi.mock('../../container-runtime.js', async original => {
    const actual = await original<typeof import('../../container-runtime.js')>();
    const exports = { ...actual, getRuntimeInfo: () => { state.trace.push(['facts']); return state.info; } }; state.runtime = exports; return exports;
});
vi.mock('../../container-identity.js', async original => {
    const actual = await original<typeof import('../../container-identity.js')>();
    const exports = { ...actual, getIdentityLabels: (value: unknown) => { state.trace.push(['identity']); return actual.getIdentityLabels(value as import('../../container-identity.js').ContainerIdentity); } }; state.identity = exports; return exports;
});
const runtime = await import('../../container-runtime.js');
const docker = await import('../../docker.js');
const base = () => ({ containerName: 'ccc-fixture-project', fullPath: '/fixture/project', projectMountPath: '/project/fixture', profile: 'work', credentialMounts: [{ hostPath: '/fixture/claude', containerPath: '/home/ccc/.claude' }], gitIdentityMounts: [{ hostPath: '/fixture/git', containerPath: '/home/ccc/.config/git' }], claudeJsonFile: '/fixture/claude.json', miseVolumeName: 'fixture-mise', codexPackagesVolumeName: 'fixture-packages', identity: { uid: 1001, gid: 2001, mapping: 'host' as const, contractVersion: '1' }, pidsLimit: '300', imageName: 'fixture-image', hostSshDir: '/fixture/ssh', sshAgentSocket: '/fixture/agent', extraMounts: [{ hostPath: '/fixture/extra', containerPath: '/extra' }], projectMountIdentity: 'project-proof', clipboardPortFile: '/fixture/clipboard.port', clipboardFilesHostDir: '/fixture/clipboard-files', labRunner: { status: 'ready' as const, stateVolumeName: 'fixture-labs', stateContainerDir: '/home/ccc/.ccc/labs', kvmDevicePath: '/dev/kvm', kvmGroupId: 0, networkMode: 'user' as const }, deviceLabStateHostDir: '/fixture/devices', deviceLabOwnerId: 'fixture-owner', deviceLabOwnerAuthFile: '/fixture/owner.json', deviceLabMountIdentity: 'device-proof', proxyEnabled: true, containerHostRemote: true });
it('matches independently frozen old facade argv and metadata/native traces', () => {
    const outputs: Record<string, unknown> = {};
    const saved = { selinux: process.env.CCC_SELINUX_RELABEL, cgroups: process.env.CCC_PODMAN_CGROUPS, container: process.env.container };
    try {
        process.env.CCC_SELINUX_RELABEL = 'off'; process.env.CCC_PODMAN_CGROUPS = 'disabled'; delete process.env.container;
        for (const mode of ['docker', 'custom-docker', 'podman-present', 'podman-absent', 'podman-machine', 'unsupported']) {
            const info = { runtime: mode.startsWith('podman') ? 'podman' as const : 'docker' as const, flavor: mode === 'podman-machine' ? 'podman-machine' as const : mode.startsWith('podman') ? 'podman-rootless' as const : 'docker-native' as const, socketPath: mode === 'custom-docker' ? '/daemon/custom.sock' : mode.startsWith('podman') ? '/fixture/podman.sock' : '/var/run/docker.sock', remote: mode === 'podman-machine', rootless: mode.startsWith('podman'), dockerDesktop: false };
            runtime._setRuntimeInfoForTest(info); state.info = { version: "0.0.0", ...info }; state.present = new Set(mode === 'podman-absent' ? ['/fixture/clipboard.port'] : ['/fixture/clipboard.port', '/fixture/podman.sock']);
            const options = base(); if (mode === 'unsupported') Object.assign(options, { labRunner: { status: 'unsupported', stateVolumeName: 'fixture-labs', stateContainerDir: '/home/ccc/.ccc/labs', networkMode: 'user', unsupportedReason: 'synthetic unavailable' } });
            const observed = new Proxy(options, { get(target, key, receiver) { state.trace.push(['option', String(key)]); return Reflect.get(target, key, receiver); } });
            state.trace = []; const args = docker.buildDockerRunArgs(observed); outputs[mode] = { args, trace: state.trace };
        }
        const options = base(); const trace: unknown[][] = []; const oldJoin = state.path.join; const oldExists = state.fs.existsSync; const oldLabels = state.identity.getIdentityLabels; const oldEntries = Object.entries;
        const beforeJoin = state.path.join as (...parts: string[]) => string;
        state.path.join = (...parts: string[]) => { trace.push(['join-old']); return beforeJoin(...parts); };
        let ownerReads = 0; Object.defineProperty(options, 'deviceLabOwnerId', { get() { trace.push(['owner', ++ownerReads]); if (ownerReads === 2) state.path.join = (...parts: string[]) => { trace.push(['join-new']); return beforeJoin(...parts); }; return 'fixture-owner'; } });
        let clipReads = 0;
        Object.defineProperty(options, 'clipboardPortFile', { get() { trace.push(['clipboard', ++clipReads]); if (clipReads === 2) state.fs.existsSync = (path: string) => { trace.push(['exists-new']); return (oldExists as (path: string) => boolean)(path); }; return '/fixture/clipboard.port'; } });
        state.fs.existsSync = (path: string) => { trace.push(['exists-old']); return (oldExists as (path: string) => boolean)(path); };
        let identityReads = 0; const value = options.identity;
        Object.defineProperty(options, 'identity', { get() { trace.push(['identity-option', ++identityReads]); if (identityReads === 2) { state.identity.getIdentityLabels = (identity: unknown) => { trace.push(['labels-new']); return (oldLabels as (v: unknown) => Record<string, string>)(identity); }; Object.entries = ((identity: object) => { trace.push(['entries-new']); return oldEntries(identity); }) as typeof Object.entries; } return value; } });
        state.identity.getIdentityLabels = (identity: unknown) => { trace.push(['labels-old']); return (oldLabels as (v: unknown) => Record<string, string>)(identity); };
        Object.entries = ((identity: object) => { trace.push(['entries-old']); return oldEntries(identity); }) as typeof Object.entries;
        state.trace = [];
        try { outputs.temporal = { args: docker.buildDockerRunArgs(options), trace }; }
        finally { state.path.join = oldJoin; state.fs.existsSync = oldExists; state.identity.getIdentityLabels = oldLabels; Object.entries = oldEntries; }
        expect((outputs.temporal as { trace: unknown[][] }).trace).toContainEqual(['join-old']);
        expect((outputs.temporal as { trace: unknown[][] }).trace).toContainEqual(['entries-old']);
        const hashes = {
    "docker": "8ae8f0c975fdb6284d2666facc943a1d6fcc23c61645af5cdd93a6eb052c6146",
    "custom-docker": "db3065c25951ff41334815ae4cfce05583cb4a3af486f6d96cdacc3216594446",
    "podman-present": "9739ec7d947473233d7f89740eb27b72178c66bf04166cffbbf790164599a6a8",
    "podman-absent": "0465480ae5653984fa715cecafa72a2ef0789f25f7228602d211804628ba391c",
    "podman-machine": "37fc07f140b8f9ce1c4dabfa6ed07fe18f7c116a225efc92fc90a7cf16197b37",
    "unsupported": "e88e0004c16b72484072f5ab18839d53c72bd0448f3cce9e83ab6222d2dd1f8a",
    "temporal": "631b1d82053536092e0b1ddb4946af01ceaf2984708b4545627ebab46e2b1f72"
};
        for (const [name, value] of Object.entries(outputs)) {
            expect(createHash("sha256").update(JSON.stringify(value)).digest("hex"), name).toBe(hashes[name as keyof typeof hashes]);
        }
    } finally { for (const [key, value] of [['CCC_SELINUX_RELABEL', saved.selinux], ['CCC_PODMAN_CGROUPS', saved.cgroups], ['container', saved.container]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } runtime._resetRuntimeCacheForTest(); }
});


it("keeps public arities and emits fresh mutable arrays", () => {
    expect(docker.buildDockerRunArgs.length).toBe(1);
    expect(runtime.bindMountArgs.length).toBe(2);
    expect(runtime.needsSelinuxRelabel.length).toBe(0);
    expect(runtime.runtimeExtraRunArgs.length).toBe(0);
    const a = runtime.bindMountArgs("named-volume", "/target"), b = runtime.bindMountArgs("named-volume", "/target");
    a.push("mutable"); expect(b).toEqual(["-v", "named-volume:/target"]);
});

it("retains Object.entries receiver when the native callee is replaced", () => {
    const original = Object.entries, receivers: unknown[] = [];
    Object.entries = (function(this: unknown, value: object) { receivers.push(this); return original(value); }) as typeof Object.entries;
    try { docker.buildDockerRunArgs(base()); } finally { Object.entries = original; }
    expect(receivers).toEqual([Object]);
});

it("invokes a captured callable without observing its call property", () => {
    const original = Object.entries, sentinel = Symbol("unexpected call lookup");
    Object.entries = new Proxy(original, {
        get(target, key, receiver) {
            if (key === "call") throw sentinel;
            return Reflect.get(target, key, receiver);
        },
    });
    try { expect(() => docker.buildDockerRunArgs(base())).not.toThrow(); }
    finally { Object.entries = original; }
});

it("ignores call-property mutation during identity calculation", () => {
    const original = Object.entries, options = base();
    const selected = function(this: unknown, value: object) {
        expect(this).toBe(Object); return original(value);
    };
    let reads = 0; const identity = options.identity;
    Object.defineProperty(options, "identity", { get() {
        if (++reads === 2) Object.defineProperty(selected, "call", { value() { throw new Error("redirected call"); } });
        return identity;
    } });
    Object.entries = selected as typeof Object.entries;
    try { expect(() => docker.buildDockerRunArgs(options)).not.toThrow(); }
    finally { Object.entries = original; }
});
