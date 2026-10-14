/** @typedef {"docker" | "podman"} InstallerRuntime */
/** @type {readonly InstallerRuntime[]} */
export const runtimePreference = ["podman", "docker"];
/** @type {readonly ("content.hash" | "dockerfile.hash")[]} */
export const imageLabels = ["content.hash", "dockerfile.hash"];
export const fingerprintFiles = [
    "Dockerfile", "Containerfile", "package.json", "package-lock.json", "tsconfig.json",
    "scripts/clipboard-shims/xclip", "scripts/clipboard-shims/xsel",
    "scripts/clipboard-shims/wl-paste", "scripts/clipboard-shims/wl-copy",
    "scripts/clipboard-shims/pbpaste",
];
export const fingerprintDirectories = ["src", "scripts", "packages", "device-lab-mcp"];
export const unixPayloadCopies = [
    { path: "dist", recursive: true },
    { path: "Dockerfile", recursive: false },
    { path: "Containerfile", recursive: false },
    { path: "Dockerfile.distribution", recursive: false },
    { path: "scripts", recursive: true },
];
export const PATH_LIMIT = 32767;
/** @param {unknown} value @returns {InstallerRuntime | null} */
export function selectedRuntimeOverride(value) {
    return value === "docker" || value === "podman" ? value : null;
}
/** @param {string} value */
export function normalizePathEntry(value) {
    return value.trim().replace(/[\\/]+$/, "").toLowerCase();
}
/** @param {string} value */
export function splitUserPath(value) {
    return (value || "").split(";").filter(part => part.trim() !== "");
}
/** @param {string} root @param {"windows"|"unix"} platform */
export function isPackagedInstall(root, platform) {
    return root.includes(`node_modules${platform === "windows" ? "\\" : "/"}`);
}
/** @param {unknown} error */
export function errorCode(error) {
    return error && typeof error === "object" && "code" in error ? error.code : undefined;
}
