import { expect } from "vitest";
import type { SpawnSyncOptions } from "node:child_process";
import type { RuntimeInfo } from "../../domain/runtime-capabilities.js";
import type { RuntimeName } from "../../domain/container-runtime.js";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeInvocation } from "../../ports/container-runtime-invocation.js";

/** Synthetic native authority for owners which already replace the process leaf. */
export function nativeRuntimeInvocationFixture(runtime: RuntimeName = "docker"): NativeRuntimeInvocation {
    return {
        version: 1, runtime, executable: `/fixture/runtime/${runtime}`,
        transport: runtime === "docker"
            ? { kind: "docker", host: "unix:///fixture/engine.sock", configDirectory: "/fixture/config",
                tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } }
            : { kind: "podman-local", graphRoot: "/fixture/storage", runRoot: "/fixture/run",
                storageDriver: "overlay", storageOptions: [], transientStore: false },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])) as NativeRuntimeInvocation["selectors"],
    };
}

type RuntimeFixtureFacade = {
    _setRuntimeInfoForTest(info: Partial<RuntimeInfo> & { runtime: RuntimeName }): void;
    _setRuntimeInvocationForTest(invocation: NativeRuntimeInvocation): void;
    getRuntimeInvocation(): NativeRuntimeInvocation;
};

/** The production preload validates/snapshots the closed record before publishing it. */
export function preloadNativeRuntimeFixture(
    facade: RuntimeFixtureFacade,
    info: Partial<RuntimeInfo> & { runtime: RuntimeName } = {runtime: "docker"},
): NativeRuntimeInvocation {
    facade._setRuntimeInfoForTest(info);
    facade._setRuntimeInvocationForTest(nativeRuntimeInvocationFixture(info.runtime));
    return facade.getRuntimeInvocation();
}

/** Keep existing logical-command assertions while checking every emitted fixture prefix. */
export function normalizeNativeRuntimeCall(call: unknown[], logicalExecutable?: string): unknown[] {
    const [program, args, options] = call;
    if (program !== "/fixture/runtime/docker" && program !== "/fixture/runtime/podman") return call;
    const runtime = program.endsWith("/docker") ? "docker" : "podman";
    const prefix = runtime === "docker"
        ? ["--config", "/fixture/config", "--host", "unix:///fixture/engine.sock", "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey="]
        : ["--remote=false", "--root", "/fixture/storage", "--runroot", "/fixture/run", "--storage-driver", "overlay", "--transient-store=false"];
    expect((args as string[]).slice(0, prefix.length)).toEqual(prefix);
    const {env, shell, ...logicalOptions} = options as SpawnSyncOptions;
    expect(shell).toBe(false);
    for (const selector of ["DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINER_SSHKEY"]) {
        expect(env?.[selector]).toBeUndefined();
    }
    return [logicalExecutable ?? runtime, (args as string[]).slice(prefix.length), logicalOptions];
}
