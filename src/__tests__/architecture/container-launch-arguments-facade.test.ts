import { it, expect, vi } from "vitest";
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

it("emits independent mutable mount arrays", () => {
    const a = runtime.bindMountArgs("named-volume", "/target"), b = runtime.bindMountArgs("named-volume", "/target");
    a.push("mutable"); expect(b).toEqual(["-v", "named-volume:/target"]);
});

it("mounts a named volume without host-path translation", () => {
    expect(runtime.bindMountArgs("named-volume", "/target")).toEqual(["-v", "named-volume:/target"]);
});
