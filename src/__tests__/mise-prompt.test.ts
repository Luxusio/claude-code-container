import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from "fs";
import {tmpdir} from "os";
import {join} from "path";

const state = vi.hoisted(() => ({dataDir: ""}));
vi.mock("../utils.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../utils.js")>();
    return {...actual, get DATA_DIR() {return state.dataDir;}, prompt: vi.fn()};
});
vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("child_process")>(),
    spawnSync: vi.fn(() => ({status: 0})),
}));
vi.mock("../scanner.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../scanner.js")>(),
    scanVersionFiles: vi.fn(),
}));

import {ensureMiseConfig} from "../index.js";
import {getProjectId, prompt} from "../utils.js";
import {scanVersionFiles} from "../scanner.js";
import {spawnSync} from "child_process";

describe("mise creation prompt preference", () => {
    let root: string;
    let project: string;
    const marker = (path: string) => join(state.dataDir, "mise-prompt-skipped", getProjectId(path));

    beforeEach(() => {
        vi.clearAllMocks();
        root = mkdtempSync(join(tmpdir(), "ccc-mise-prompt-"));
        state.dataDir = join(root, "ccc-data");
        project = join(root, "project");
        mkdirSync(project);
        vi.mocked(prompt).mockResolvedValue("n");
        vi.mocked(scanVersionFiles).mockReturnValue(new Map([["package.json", "{}"]]));
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(root, {recursive: true, force: true});
    });

    it.each(["n", "no"])("remembers %s across launches and skips scanning", async (answer) => {
        vi.mocked(prompt).mockResolvedValue(answer);
        await ensureMiseConfig(project);
        expect(existsSync(marker(project))).toBe(true);
        expect(readdirSync(project)).toEqual([]);
        await ensureMiseConfig(join(project, "."));
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(scanVersionFiles).toHaveBeenCalledTimes(1);
        expect(spawnSync).not.toHaveBeenCalled();
        rmSync(marker(project));
        await ensureMiseConfig(project);
        expect(prompt).toHaveBeenCalledTimes(2);
    });

    it("isolates different project paths with the same basename", async () => {
        const other = join(root, "other", "project");
        mkdirSync(other, {recursive: true});
        await ensureMiseConfig(project);
        await ensureMiseConfig(other);
        expect(prompt).toHaveBeenCalledTimes(2);
        expect(marker(other)).not.toBe(marker(project));
        expect(existsSync(marker(other))).toBe(true);
    });

    it.each(["mise.toml", ".mise.toml"])("preserves existing %s with or without a decline", async (filename) => {
        writeFileSync(join(project, filename), "[tools]\n");
        await ensureMiseConfig(project);
        mkdirSync(join(state.dataDir, "mise-prompt-skipped"), {recursive: true});
        writeFileSync(marker(project), "");
        await ensureMiseConfig(project);
        expect(prompt).not.toHaveBeenCalled();
        expect(scanVersionFiles).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
    });

    it("does not offer or save a preference without version files", async () => {
        vi.mocked(scanVersionFiles).mockReturnValue(new Map());
        await ensureMiseConfig(project);
        expect(prompt).not.toHaveBeenCalled();
        expect(existsSync(marker(project))).toBe(false);
    });

    it.each(["", "y", "yes"])("retains generation for acceptance %j", async (answer) => {
        vi.mocked(prompt).mockResolvedValue(answer);
        await ensureMiseConfig(project);
        expect(spawnSync).toHaveBeenCalledWith("claude", expect.any(Array), expect.objectContaining({cwd: project}));
        expect(existsSync(join(project, "mise.toml"))).toBe(true);
        expect(existsSync(marker(project))).toBe(false);
        expect(prompt).toHaveBeenCalledWith(expect.stringContaining("[Y/n]"), true);
    });

    it("does not remember unrelated responses", async () => {
        vi.mocked(prompt).mockResolvedValue("later");
        await ensureMiseConfig(project);
        await ensureMiseConfig(project);
        expect(prompt).toHaveBeenCalledTimes(2);
        expect(existsSync(marker(project))).toBe(false);
        expect(spawnSync).not.toHaveBeenCalled();
    });

    it("warns and continues if the preference cannot be saved", async () => {
        mkdirSync(state.dataDir);
        writeFileSync(join(state.dataDir, "mise-prompt-skipped"), "not a directory");
        await expect(ensureMiseConfig(project)).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Could not save"));
        expect(spawnSync).not.toHaveBeenCalled();
        await ensureMiseConfig(project);
        expect(prompt).toHaveBeenCalledTimes(2);
    });
});
