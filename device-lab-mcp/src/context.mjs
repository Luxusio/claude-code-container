import { createHash } from "crypto";
import { basename, dirname, posix, resolve } from "path";
import { fileURLToPath } from "url";

export const DISPLAY = ":99";
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function projectId(projectPath) {
    if (typeof projectPath === "string" && projectPath.startsWith("/project/")) {
        const normalized = posix.normalize(projectPath);
        const parts = normalized.split("/");
        if (normalized === projectPath && parts.length === 3 && parts[1] === "project" && /^[a-z0-9-]{0,255}-[a-f0-9]{12}$/.test(parts[2])) {
            return parts[2];
        }
    }
    const resolved = resolve(projectPath || "/project");
    const name = basename(resolved).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    return `${name}-${hash}`;
}

export function ownerBasis(cwd = process.cwd(), profile = process.env.CCC_PROFILE || undefined) {
    const id = projectId(cwd);
    const containerName = profile ? `ccc-${id}--p--${profile}` : `ccc-${id}`;
    return `${containerName}:/project/${id}`;
}

export function ownerId() {
    return createHash("sha256").update(ownerBasis()).digest("hex").slice(0, 16);
}

export function slug(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "device";
}
