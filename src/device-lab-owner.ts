import { createHash } from "crypto";
import { posix } from "path";
import { getProjectId } from "./utils.js";

const DEVICE_LAB_PROJECT_ID_PATTERN = /^[a-z0-9-]{0,255}-[a-f0-9]{12}$/;
const DEVICE_LAB_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function projectIdFromCanonicalMount(projectPath: string): string | null {
    if (typeof projectPath !== "string" || !projectPath.startsWith("/project/")) return null;
    const normalized = posix.normalize(projectPath);
    if (normalized !== projectPath) return null;
    const parts = normalized.split("/");
    return parts.length === 3 && parts[1] === "project" && DEVICE_LAB_PROJECT_ID_PATTERN.test(parts[2])
        ? parts[2]
        : null;
}

function deviceLabProjectId(projectPath: string): string {
    return projectIdFromCanonicalMount(projectPath) || getProjectId(projectPath);
}

export function deviceLabProjectMountPath(projectPath: string): string {
    return `/project/${deviceLabProjectId(projectPath)}`;
}

export function deviceLabContainerName(projectPath: string, profile?: string): string {
    const base = `ccc-${deviceLabProjectId(projectPath)}`;
    return profile ? `${base}--p--${profile}` : base;
}

export function deviceLabOwnerBasis(projectPath: string, profile?: string): string {
    const containerName = deviceLabContainerName(projectPath, profile);
    const projectMountPath = deviceLabProjectMountPath(projectPath);
    return [containerName, projectMountPath].join(":");
}

export function deviceLabOwnerId(projectPath: string, profile?: string): string {
    return createHash("sha256").update(deviceLabOwnerBasis(projectPath, profile)).digest("hex").slice(0, 16);
}

export function deviceLabOwnerFromProjectMountPath(projectMountPath: string, profile?: string): {
    ownerId: string;
    ownerBasis: string;
    projectMountPath: string;
    projectId: string;
    profile?: string;
} | null {
    if (typeof projectMountPath !== "string" || !projectMountPath.startsWith("/project/")) return null;
    if (profile !== undefined && !DEVICE_LAB_PROFILE_PATTERN.test(profile)) return null;
    const normalized = posix.normalize(projectMountPath);
    const projectId = projectIdFromCanonicalMount(projectMountPath);
    if (!projectId) return null;
    const containerName = profile ? `ccc-${projectId}--p--${profile}` : `ccc-${projectId}`;
    const ownerBasis = `${containerName}:${normalized}`;
    return {
        ownerId: createHash("sha256").update(ownerBasis).digest("hex").slice(0, 16),
        ownerBasis,
        projectMountPath: normalized,
        projectId,
        ...(profile ? { profile } : {}),
    };
}
