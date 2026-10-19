import type { RuntimeName } from "../domain/container-runtime.js";

/** Only selectors which can affect the native executable or its transport cross IPC. */
export const NATIVE_RUNTIME_SELECTOR_KEYS = Object.freeze([
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DOCKER_CONFIG", "DOCKER_CONTEXT",
    "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_API_VERSION",
    "DOCKER_SSH_COMMAND", "SSH_AUTH_SOCK", "CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINER_SSHKEY",
    "CONTAINER_PROXY", "PODMAN_CONNECTIONS_CONF",
    "CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE", "CONTAINERS_CONF_MODULE", "CONTAINERS_STORAGE_CONF",
    "STORAGE_DRIVER", "STORAGE_OPTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
] as const);

export type NativeRuntimeSelector = typeof NATIVE_RUNTIME_SELECTOR_KEYS[number];
export type NativeRuntimeSelectors = Readonly<Record<NativeRuntimeSelector, string | null>>;

export interface DockerRuntimeTransport {
    readonly kind: "docker";
    readonly host: string;
    readonly configDirectory: string;
    readonly tls: Readonly<{
        enabled: boolean;
        verify: boolean;
        caFile: string | null;
        certFile: string | null;
        keyFile: string | null;
    }>;
}

export interface PodmanLocalRuntimeTransport {
    readonly kind: "podman-local";
    readonly graphRoot: string;
    readonly runRoot: string;
    readonly storageDriver: string;
    readonly storageOptions: readonly string[];
    readonly transientStore: boolean;
}

export interface PodmanRemoteRuntimeTransport {
    readonly kind: "podman-remote";
    readonly url: string;
    readonly identityFile: string | null;
    readonly machine: boolean;
    readonly tls: Readonly<{ caFile: string | null; certFile: string | null; keyFile: string | null }>;
}

export type NativeRuntimeTransport = DockerRuntimeTransport | PodmanLocalRuntimeTransport | PodmanRemoteRuntimeTransport;

/** Native authority is distinct from RuntimeInfo's capability and mount compatibility facts. */
export type NativeRuntimeInvocation = Readonly<{
    version: 1;
    runtime: RuntimeName;
    executable: string;
    transport: NativeRuntimeTransport;
    selectors: NativeRuntimeSelectors;
}>;
