import { afterEach, describe, expect, it } from "vitest";
import { ownerBasis, ownerId, projectMountPath } from "../../device-lab-mcp/src/context.mjs";
import { deviceLabOwnerBasis, deviceLabOwnerId, deviceLabProjectMountPath } from "../device-lab-owner.js";

describe("device-lab-mcp owner context", () => {
    const originalProfile = process.env.CCC_PROFILE;

    afterEach(() => {
        if (originalProfile === undefined) delete process.env.CCC_PROFILE;
        else process.env.CCC_PROFILE = originalProfile;
    });

    it("uses canonical project owner basis by default", () => {
        delete process.env.CCC_PROFILE;

        expect(ownerBasis()).toBe(deviceLabOwnerBasis(process.cwd()));
        expect(ownerId()).toBe(deviceLabOwnerId(process.cwd()));
    });

    it("includes profile in the canonical default owner basis", () => {
        process.env.CCC_PROFILE = "work";

        expect(ownerBasis()).toBe(deviceLabOwnerBasis(process.cwd(), "work"));
        expect(ownerId()).toBe(deviceLabOwnerId(process.cwd(), "work"));
    });

    it("maps Windows host paths to canonical project mount paths", () => {
        const windowsPath = "C:\\Users\\Luxus\\Project\\claude-code-container";
        expect(projectMountPath(windowsPath)).toBe(deviceLabProjectMountPath(windowsPath));
        expect(projectMountPath(windowsPath)).toMatch(/^\/project\/[a-z0-9-]+-[a-f0-9]{12}$/);
        expect(projectMountPath(windowsPath)).not.toContain(":\\");
    });
});
