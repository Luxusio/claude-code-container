import { createHash } from "crypto";
import { hostname } from "os";
import { dirname } from "path";
import { fileURLToPath } from "url";

export const DISPLAY = ":99";
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function ownerId() {
    const basis = [
        hostname(),
        process.cwd() || "/project",
    ].join(":");
    return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

export function slug(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "device";
}
