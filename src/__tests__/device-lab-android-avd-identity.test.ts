import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    readAndroidAvdIdentity,
    readAndroidAvdIdentityAsync,
    type AndroidAvdIdentityCommandResult,
} from "@ccc/device-lab/providers/state/android-avd-identity.mjs";
import {
    listOwnedAndroidAvdArtifacts,
    listOwnedAndroidAvdArtifactsAsync,
    removeOwnedAndroidAvdArtifacts,
    removeOwnedAndroidAvdArtifactsAsync,
    type AndroidAvdStorageAsyncOptions,
} from "@ccc/device-lab/providers/state/android-avd-storage.mjs";

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("Android console AVD identity", () => {
    const serial = "emulator-5638";
    const normal = ["-s", serial, "emu", "avd", "name"];
    const retry = ["-s", serial, "emu", "avd name\navd name"];
    const success = (stdout: string) => ({ status: 0, stdout, stderr: "" });

    it("accepts the normal console reply with one read-only command", async () => {
        const run = vi.fn().mockReturnValue(success("Pixel_8-API.35\r\nOK\r\n"));
        expect(await readAndroidAvdIdentity(serial, run)).toEqual({ ok: true, name: "Pixel_8-API.35" });
        expect(run.mock.calls).toEqual([[normal]]);
    });

    it.each(["", " \r\n", "OK\r\nOK\r\n"])("retries successful stripped output %j exactly once", async first => {
        const run = vi.fn().mockReturnValueOnce(success(first))
            .mockReturnValueOnce(success("Other_Project_AVD\nOther_Project_AVD\nOK\n"));
        expect(await readAndroidAvdIdentity(serial, run)).toEqual({ ok: true, name: "Other_Project_AVD" });
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it("accepts the one name retained after ADB strips the retry's first reply", () => {
        const run = vi.fn().mockReturnValueOnce(success(""))
            .mockReturnValueOnce(success("Other_Project_AVD\r\nOK\r\n"));
        expect(readAndroidAvdIdentity(serial, run)).toEqual({ ok: true, name: "Other_Project_AVD" });
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it.each([
        ["still empty", ""], ["only OK", "OK\n"],
        ["conflicting names", "Pixel_A\nPixel_B\nOK\n"],
        ["invalid name", "../Pixel_A\nOK\n"],
        ["console error", "KO: unknown command\n"],
        ["name followed by error", "Pixel_A\nKO: failed\n"],
    ])("rejects %s from the compatibility retry", async (_label, output) => {
        const run = vi.fn().mockReturnValueOnce(success(""))
            .mockReturnValueOnce(success(output));
        expect(await readAndroidAvdIdentity(serial, run)).toEqual(expect.objectContaining({ ok: false }));
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it.each([
        { status: 1, stdout: "", stderr: "" },
        { status: null, stdout: "", stderr: "" },
        { status: 0, stdout: "", stderr: "console failed" },
        { status: 0, stdout: "", error: new Error("timeout") },
        success("KO: authentication required\n"),
        success("Pixel_A\nPixel_B\n"),
        success("Invalid Name\n"),
    ])("does not retry a failed or invalid normal response %#", async result => {
        const run = vi.fn().mockReturnValue(result);
        expect(await readAndroidAvdIdentity(serial, run)).toEqual(expect.objectContaining({ ok: false }));
        expect(run.mock.calls).toEqual([[normal]]);
    });

    it("rejects a failed retry even when stdout contains a plausible name", async () => {
        const run = vi.fn().mockReturnValueOnce(success(""))
            .mockReturnValueOnce({ status: 1, stdout: "Pixel_A\n", stderr: "" });
        expect(await readAndroidAvdIdentity(serial, run)).toEqual(expect.objectContaining({ ok: false }));
        expect(run).toHaveBeenCalledTimes(2);
    });
});

describe("asynchronous Android console AVD identity", () => {
    const serial = "emulator-5638";
    const normal = ["-s", serial, "emu", "avd", "name"];
    const retry = ["-s", serial, "emu", "avd name\navd name"];
    const success = (stdout: string) => ({ status: 0, stdout, stderr: "" });

    it("accepts a synchronous or asynchronous normal reply without retrying", async () => {
        for (const reply of [success("Pixel_8-API.35\r\nOK\r\n"), Promise.resolve(success("Pixel_8-API.35\r\nOK\r\n"))]) {
            const run = vi.fn().mockReturnValue(reply);
            expect(await readAndroidAvdIdentityAsync(serial, run)).toEqual({ ok: true, name: "Pixel_8-API.35" });
            expect(run.mock.calls).toEqual([[normal]]);
        }
    });

    it.each(["", " \r\n", "OK\r\nOK\r\n"])("retries successful stripped output %j exactly once", async first => {
        const run = vi.fn().mockResolvedValueOnce(success(first))
            .mockResolvedValueOnce(success("Other_Project_AVD\nOther_Project_AVD\nOK\n"));
        expect(await readAndroidAvdIdentityAsync(serial, run)).toEqual({ ok: true, name: "Other_Project_AVD" });
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it("accepts the one name retained after ADB strips the retry's first reply", async () => {
        const run = vi.fn().mockResolvedValueOnce(success(""))
            .mockResolvedValueOnce(success("Other_Project_AVD\r\nOK\r\n"));
        expect(await readAndroidAvdIdentityAsync(serial, run)).toEqual({ ok: true, name: "Other_Project_AVD" });
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it.each([
        ["still empty", ""], ["only OK", "OK\n"],
        ["conflicting names", "Pixel_A\nPixel_B\nOK\n"],
        ["invalid name", "../Pixel_A\nOK\n"],
        ["console error", "KO: unknown command\n"],
        ["name followed by error", "Pixel_A\nKO: failed\n"],
    ])("rejects %s from the compatibility retry", async (_label, output) => {
        const run = vi.fn().mockResolvedValueOnce(success(""))
            .mockResolvedValueOnce(success(output));
        expect(await readAndroidAvdIdentityAsync(serial, run)).toEqual(expect.objectContaining({ ok: false }));
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it.each([
        { status: 1, stdout: "", stderr: "" },
        { status: null, stdout: "", stderr: "" },
        { status: 0, stdout: "", stderr: "console failed" },
        { status: 0, stdout: "", error: new Error("timeout") },
        success("KO: authentication required\n"),
        success("Pixel_A\nPixel_B\n"),
        success("Invalid Name\n"),
    ])("does not retry a failed or invalid normal response %#", async result => {
        const run = vi.fn().mockResolvedValue(result);
        expect(await readAndroidAvdIdentityAsync(serial, run)).toEqual(expect.objectContaining({ ok: false }));
        expect(run.mock.calls).toEqual([[normal]]);
    });

    it("rejects a failed retry even when stdout contains a plausible name", async () => {
        const run = vi.fn().mockResolvedValueOnce(success(""))
            .mockResolvedValueOnce({ status: 1, stdout: "Pixel_A\n", stderr: "" });
        expect(await readAndroidAvdIdentityAsync(serial, run)).toEqual(expect.objectContaining({ ok: false }));
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it("awaits each console command before deciding whether to retry or return", async () => {
        const first = deferred<AndroidAvdIdentityCommandResult>();
        const second = deferred<AndroidAvdIdentityCommandResult>();
        const retryEntered = deferred<void>();
        const run = vi.fn().mockReturnValueOnce(first.promise).mockImplementationOnce(() => {
            retryEntered.resolve(undefined);
            return second.promise;
        });
        let settled = false;
        const pending = readAndroidAvdIdentityAsync(serial, run);
        void pending.then(() => { settled = true; }, () => { settled = true; });
        try {
            expect(run.mock.calls).toEqual([[normal]]);
            expect(settled).toBe(false);
            first.resolve(success(""));
            await retryEntered.promise;
            expect(run.mock.calls).toEqual([[normal], [retry]]);
            expect(settled).toBe(false);
            second.resolve(success("Pixel_A\nPixel_A\nOK\n"));
            expect(await pending).toEqual({ ok: true, name: "Pixel_A" });
        } finally {
            first.resolve(success(""));
            second.resolve(success("Pixel_A\nOK\n"));
            await pending.catch(() => {});
        }
    });

    it("preserves a rejected native command without issuing the fallback", async () => {
        const error = new Error("native-command-rejected");
        const run = vi.fn().mockRejectedValue(error);
        await expect(readAndroidAvdIdentityAsync(serial, run)).rejects.toBe(error);
        expect(run.mock.calls).toEqual([[normal]]);
    });
});

describe("owned Android AVD artifact storage", () => {
    const owner = "0123456789abcdef";
    const name = `ccc-${owner}-Pixel_8`;
    const foreignName = "ccc-fedcba9876543210-Foreign";
    let fixtureRoot: string;
    let root: string;
    let dataPath: string;
    let iniPath: string;

    beforeEach(async () => {
        fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "ccc-android-avd-storage-")));
        root = join(fixtureRoot, "avd");
        dataPath = join(root, `${name}.avd`);
        iniPath = join(root, `${name}.ini`);
        await mkdir(root);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    async function seedAvd(avdRoot = root, avdName = name, content = "owned-data") {
        await mkdir(join(avdRoot, `${avdName}.avd`));
        await writeFile(join(avdRoot, `${avdName}.avd`, "config.ini"), content);
        await writeFile(join(avdRoot, `${avdName}.ini`), `registration:${content}`);
    }

    async function quarantineEntries() {
        return (await readdir(root)).filter(entry => entry.startsWith(".ccc-avd-delete-"));
    }

    it("retains synchronous listing and cleanup while preserving another owner's files", async () => {
        await seedAvd();
        await seedAvd(root, foreignName, "foreign-data");
        const artifacts = listOwnedAndroidAvdArtifacts(owner, { root });
        expect(artifacts.map(artifact => artifact.name)).toEqual([name]);
        expect(removeOwnedAndroidAvdArtifacts(name, owner, { root, verifyInactive: () => true }))
            .toEqual({ name, root, removed: 2 });
        expect(listOwnedAndroidAvdArtifacts(owner, { root })).toEqual([]);
        expect(await readFile(join(root, `${foreignName}.avd`, "config.ini"), "utf8")).toBe("foreign-data");
        expect(await readFile(join(root, `${foreignName}.ini`), "utf8")).toBe("registration:foreign-data");
    });

    it("asynchronously lists the same owned source and recovery artifacts as the synchronous API", async () => {
        await seedAvd();
        await seedAvd(root, foreignName, "foreign-data");
        const quarantine = join(root, `.ccc-avd-delete-${name}-${"a".repeat(32)}`);
        await mkdir(quarantine);
        await writeFile(join(quarantine, "registration.ini"), "recoverable-registration");
        const artifacts = await listOwnedAndroidAvdArtifactsAsync(owner, { root });
        expect(artifacts).toEqual(listOwnedAndroidAvdArtifacts(owner, { root }));
        expect(artifacts).toEqual([expect.objectContaining({
            name, root, dataPath, iniPath,
            quarantines: [expect.objectContaining({ path: quarantine })],
        })]);
    });

    it.each([["active", false], ["unknown", undefined]] as const)("awaits initial inactivity and refuses %s before staging", async (_label, inactive) => {
        await seedAvd();
        const entered = deferred<void>();
        const check = deferred<boolean | undefined>();
        const onArtifactQuarantined = vi.fn();
        const verifyInactive = vi.fn().mockImplementation(() => {
            entered.resolve(undefined);
            return check.promise;
        });
        const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, { root, verifyInactive, onArtifactQuarantined });
        void pending.catch(() => {});
        try {
            await entered.promise;
            expect(await quarantineEntries()).toEqual([]);
            expect(await readFile(iniPath, "utf8")).toBe("registration:owned-data");
            check.resolve(inactive);
            await expect(pending).rejects.toThrow(/active|inactive|liveness/i);
            expect(onArtifactQuarantined).not.toHaveBeenCalled();
            expect(verifyInactive.mock.calls).toEqual([[name]]);
            expect(await readFile(join(dataPath, "config.ini"), "utf8")).toBe("owned-data");
            expect(await quarantineEntries()).toEqual([]);
        } finally {
            check.resolve(false);
            await pending.catch(() => {});
        }
    });

    it.each([["active", false], ["unknown", undefined]] as const)("awaits fresh inactivity and rolls staged artifacts back when it becomes %s", async (_label, inactive) => {
        await seedAvd();
        const freshEntered = deferred<void>();
        const check = deferred<boolean | undefined>();
        const verifyInactive = vi.fn().mockResolvedValueOnce(true).mockImplementationOnce(() => {
            freshEntered.resolve(undefined);
            return check.promise;
        });
        let settled = false;
        const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, { root, verifyInactive });
        void pending.then(() => { settled = true; }, () => { settled = true; });
        try {
            await freshEntered.promise;
            expect(settled).toBe(false);
            const quarantines = await quarantineEntries();
            expect(quarantines).toHaveLength(1);
            expect((await readdir(join(root, quarantines[0]))).sort()).toEqual(["data.avd", "registration.ini"]);
            check.resolve(inactive);
            await expect(pending).rejects.toThrow(/active|inactive|liveness/i);
            expect(verifyInactive.mock.calls).toEqual([[name], [name]]);
            expect(await readFile(iniPath, "utf8")).toBe("registration:owned-data");
            expect(await readFile(join(dataPath, "config.ini"), "utf8")).toBe("owned-data");
            expect(await quarantineEntries()).toEqual([]);
        } finally {
            check.resolve(false);
            await pending.catch(() => {});
        }
    });

    it("preserves a replacement storage root after awaiting initial inactivity", async () => {
        await seedAvd();
        const entered = deferred<void>();
        const check = deferred<boolean>();
        const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, {
            root,
            verifyInactive: () => { entered.resolve(undefined); return check.promise; },
        });
        void pending.catch(() => {});
        const displacedRoot = join(fixtureRoot, "captured-avd-root");
        try {
            await entered.promise;
            await rename(root, displacedRoot);
            await mkdir(root);
            await seedAvd(root, name, "foreign-replacement-root");
            const replacement = await lstat(root);
            check.resolve(true);
            await expect(pending).rejects.toThrow(/identity changed/i);
            expect((await lstat(root)).ino).toBe(replacement.ino);
            expect(await readFile(iniPath, "utf8")).toBe("registration:foreign-replacement-root");
            expect(await readFile(join(dataPath, "config.ini"), "utf8")).toBe("foreign-replacement-root");
            expect(await readFile(join(displacedRoot, `${name}.avd`, "config.ini"), "utf8")).toBe("owned-data");
        } finally {
            check.resolve(false);
            await pending.catch(() => {});
        }
    });

    it("preserves a replacement source inode after awaiting initial inactivity", async () => {
        await seedAvd();
        const entered = deferred<void>();
        const check = deferred<boolean>();
        const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, {
            root,
            verifyInactive: () => { entered.resolve(undefined); return check.promise; },
        });
        void pending.catch(() => {});
        const displacedData = join(fixtureRoot, "captured-data.avd");
        try {
            await entered.promise;
            await rename(dataPath, displacedData);
            await mkdir(dataPath);
            await writeFile(join(dataPath, "config.ini"), "foreign-replacement-source");
            const replacement = await lstat(dataPath);
            check.resolve(true);
            await expect(pending).rejects.toThrow(/identity changed/i);
            expect((await lstat(dataPath)).ino).toBe(replacement.ino);
            expect(await readFile(join(dataPath, "config.ini"), "utf8")).toBe("foreign-replacement-source");
            expect(await readFile(join(displacedData, "config.ini"), "utf8")).toBe("owned-data");
            expect(await readFile(iniPath, "utf8")).toBe("registration:owned-data");
            expect(await quarantineEntries()).toEqual([]);
        } finally {
            check.resolve(false);
            await pending.catch(() => {});
        }
    });

    it("preserves a replacement staged inode after awaiting a quarantine callback", async () => {
        await seedAvd();
        const entered = deferred<{ originalPath: string; quarantinePath: string }>();
        const callback = deferred<void>();
        const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, {
            root,
            verifyInactive: async () => true,
            onArtifactQuarantined: async artifact => {
                if (artifact.originalPath === iniPath) {
                    entered.resolve(artifact);
                    await callback.promise;
                }
            },
        });
        void pending.catch(() => {});
        try {
            const artifact = await entered.promise;
            const displacedRegistration = join(fixtureRoot, "captured-registration.ini");
            await rename(artifact.quarantinePath, displacedRegistration);
            await writeFile(artifact.quarantinePath, "foreign-replacement-staged");
            const replacement = await lstat(artifact.quarantinePath);
            callback.resolve(undefined);
            await expect(pending).rejects.toThrow(/identity changed/i);
            expect((await lstat(artifact.quarantinePath)).ino).toBe(replacement.ino);
            expect(await readFile(artifact.quarantinePath, "utf8")).toBe("foreign-replacement-staged");
            expect(await readFile(displacedRegistration, "utf8")).toBe("registration:owned-data");
            expect(await readFile(join(dataPath, "config.ini"), "utf8")).toBe("owned-data");
        } finally {
            callback.resolve(undefined);
            await pending.catch(() => {});
        }
    });

    it("awaits a rejected quarantine callback and restores captured sources", async () => {
        await seedAvd();
        const entered = deferred<void>();
        const callback = deferred<void>();
        const error = new Error("fixture-quarantine-failure");
        const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, {
            root,
            verifyInactive: async () => true,
            onArtifactQuarantined: artifact => {
                if (artifact.originalPath === dataPath) {
                    entered.resolve(undefined);
                    return callback.promise;
                }
            },
        });
        void pending.catch(() => {});
        try {
            await entered.promise;
            const quarantines = await quarantineEntries();
            expect(quarantines).toHaveLength(1);
            expect((await readdir(join(root, quarantines[0]))).sort()).toEqual(["data.avd", "registration.ini"]);
            callback.reject(error);
            await expect(pending).rejects.toBe(error);
            expect(await readFile(iniPath, "utf8")).toBe("registration:owned-data");
            expect(await readFile(join(dataPath, "config.ini"), "utf8")).toBe("owned-data");
            expect(await quarantineEntries()).toEqual([]);
        } finally {
            callback.resolve(undefined);
            await pending.catch(() => {});
        }
    });

    it.each(["a replacement storage root", "a replacement staged inode", "a successor destination"] as const)(
        "preserves %s when rollback's destination lookup resumes with stale absence",
        async change => {
            await seedAvd();
            const lookupEntered = deferred<{ originalPath: string; quarantinePath: string }>();
            const lookupRelease = deferred<void>();
            const cleanupError = new Error("fixture-quarantine-failure-before-rollback");
            const realLstat = fsPromises.lstat.bind(fsPromises);
            let rollbackArtifact: { originalPath: string; quarantinePath: string } | undefined;
            let held = false;
            vi.spyOn(fsPromises, "lstat").mockImplementation((async (...args: Parameters<typeof fsPromises.lstat>) => {
                try {
                    return await realLstat(...args);
                } catch (error) {
                    if (rollbackArtifact && !held && String(args[0]) === iniPath
                        && (error as NodeJS.ErrnoException).code === "ENOENT") {
                        held = true;
                        // Capture the native absence result after rollback checked its
                        // root, quarantine and staged entry, then delay its delivery.
                        lookupEntered.resolve(rollbackArtifact);
                        await lookupRelease.promise;
                    }
                    throw error;
                }
            }) as typeof fsPromises.lstat);
            const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, {
                root,
                verifyInactive: async () => true,
                onArtifactQuarantined: artifact => {
                    if (artifact.originalPath === iniPath) {
                        rollbackArtifact = artifact;
                        throw cleanupError;
                    }
                },
            });
            void pending.catch(() => {});
            try {
                const artifact = await lookupEntered.promise;
                expect(held).toBe(true);
                const quarantine = dirname(artifact.quarantinePath);
                const capturedQuarantine = await lstat(quarantine);
                const capturedRegistration = await lstat(artifact.quarantinePath);
                let recoveryRoot = quarantine;
                let recoveryPath = artifact.quarantinePath;
                let recoveryDataPath = join(dataPath, "config.ini");
                const replacements: Array<{ path: string; content: string; dev: number; ino: number }> = [];
                const replacementDirectories: Array<{ path: string; dev: number; ino: number }> = [];
                async function writeReplacement(path: string, content: string) {
                    await writeFile(path, content);
                    const { dev, ino } = await lstat(path);
                    replacements.push({ path, content, dev, ino });
                }
                if (change === "a replacement storage root") {
                    const displacedRoot = join(fixtureRoot, "captured-rollback-root");
                    await rename(root, displacedRoot);
                    await mkdir(root);
                    await mkdir(quarantine);
                    await mkdir(dataPath);
                    for (const path of [root, quarantine, dataPath]) {
                        const { dev, ino } = await lstat(path);
                        replacementDirectories.push({ path, dev, ino });
                    }
                    await writeReplacement(artifact.quarantinePath, "foreign-root-registration");
                    await writeReplacement(join(dataPath, "config.ini"), "foreign-root-data");
                    recoveryRoot = join(displacedRoot, basename(quarantine));
                    recoveryPath = join(recoveryRoot, basename(artifact.quarantinePath));
                    recoveryDataPath = join(displacedRoot, `${name}.avd`, "config.ini");
                } else if (change === "a replacement staged inode") {
                    recoveryPath = join(quarantine, "captured-registration.ini");
                    await rename(artifact.quarantinePath, recoveryPath);
                    await writeReplacement(artifact.quarantinePath, "foreign-staged-registration");
                } else {
                    await writeReplacement(iniPath, "foreign-successor-registration");
                }
                lookupRelease.resolve(undefined);
                await expect(pending).rejects.toBe(cleanupError);
                for (const replacement of replacements) {
                    expect(await readFile(replacement.path, "utf8")).toBe(replacement.content);
                    expect(await lstat(replacement.path)).toMatchObject({ dev: replacement.dev, ino: replacement.ino });
                }
                for (const replacement of replacementDirectories) {
                    expect(await lstat(replacement.path)).toMatchObject({ dev: replacement.dev, ino: replacement.ino });
                }
                expect(await lstat(recoveryRoot)).toMatchObject({ dev: capturedQuarantine.dev, ino: capturedQuarantine.ino });
                expect(await lstat(recoveryPath)).toMatchObject({ dev: capturedRegistration.dev, ino: capturedRegistration.ino });
                expect(await readFile(recoveryPath, "utf8")).toBe("registration:owned-data");
                expect(await readFile(recoveryDataPath, "utf8")).toBe("owned-data");
                if (change !== "a successor destination") {
                    await expect(lstat(iniPath)).rejects.toMatchObject({ code: "ENOENT" });
                }
            } finally {
                lookupRelease.resolve(undefined);
                await pending.catch(() => {});
            }
        },
    );

    it("rechecks an existing quarantine inode after fresh inactivity settles", async () => {
        const quarantine = join(root, `.ccc-avd-delete-${name}-${"b".repeat(32)}`);
        await mkdir(quarantine);
        await writeFile(join(quarantine, "registration.ini"), "recoverable-registration");
        const entered = deferred<void>();
        const check = deferred<boolean>();
        const verifyInactive = vi.fn().mockResolvedValueOnce(true).mockImplementationOnce(() => {
            entered.resolve(undefined);
            return check.promise;
        });
        const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, { root, verifyInactive });
        void pending.catch(() => {});
        const displacedQuarantine = join(fixtureRoot, "captured-quarantine");
        try {
            await entered.promise;
            await rename(quarantine, displacedQuarantine);
            await mkdir(quarantine);
            await writeFile(join(quarantine, "foreign.txt"), "foreign-replacement-quarantine");
            const replacement = await lstat(quarantine);
            check.resolve(true);
            await expect(pending).rejects.toThrow(/identity changed/i);
            expect((await lstat(quarantine)).ino).toBe(replacement.ino);
            expect(await readFile(join(quarantine, "foreign.txt"), "utf8")).toBe("foreign-replacement-quarantine");
            expect(await readFile(join(displacedQuarantine, "registration.ini"), "utf8")).toBe("recoverable-registration");
        } finally {
            check.resolve(false);
            await pending.catch(() => {});
        }
    });

    it("awaits quarantine callbacks in order and returns success only after final absence", async () => {
        await seedAvd();
        await seedAvd(root, foreignName, "foreign-data");
        const entered = deferred<{ quarantinePath: string }>();
        const callback = deferred<void>();
        const trace: string[] = [];
        const onArtifactQuarantined = vi.fn<NonNullable<AndroidAvdStorageAsyncOptions["onArtifactQuarantined"]>>(async artifact => {
            trace.push(`quarantine:${basename(artifact.originalPath)}`);
            if (artifact.originalPath === iniPath) {
                entered.resolve(artifact);
                await callback.promise;
            }
        });
        let settled = false;
        const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, {
            root,
            verifyInactive: async () => { trace.push("inactive"); return true; },
            onArtifactQuarantined,
        });
        void pending.then(() => { settled = true; }, () => { settled = true; });
        try {
            const artifact = await entered.promise;
            expect(settled).toBe(false);
            expect(onArtifactQuarantined).toHaveBeenCalledTimes(1);
            expect(trace).toEqual(["inactive", `quarantine:${name}.ini`]);
            expect(await readdir(dirname(artifact.quarantinePath))).toEqual(["registration.ini"]);
            expect(await readFile(join(dataPath, "config.ini"), "utf8")).toBe("owned-data");
            callback.resolve(undefined);
            expect(await pending).toEqual({ name, root, removed: 2 });
            expect(trace.at(-1)).toBe("inactive");
            expect(trace.filter(step => step.startsWith("quarantine:"))).toEqual([`quarantine:${name}.ini`, `quarantine:${name}.avd`]);
            expect(await listOwnedAndroidAvdArtifactsAsync(owner, { root })).toEqual([]);
            expect(await quarantineEntries()).toEqual([]);
            expect((await readdir(root)).sort()).toEqual([`${foreignName}.avd`, `${foreignName}.ini`]);
            expect(await readFile(join(root, `${foreignName}.avd`, "config.ini"), "utf8")).toBe("foreign-data");
        } finally {
            callback.resolve(undefined);
            await pending.catch(() => {});
        }
    });

    it("refuses success when a source reappears and preserves its replacement contents", async () => {
        await seedAvd();
        const staged: string[] = [];
        const pending = removeOwnedAndroidAvdArtifactsAsync(name, owner, {
            root,
            onArtifactQuarantined: async artifact => { staged.push(artifact.originalPath); },
            verifyInactive: async () => {
                if (staged.length === 2) await writeFile(iniPath, "foreign-reappeared-registration");
                return true;
            },
        });
        await expect(pending).rejects.toThrow();
        expect(staged).toEqual([iniPath, dataPath]);
        expect(await readFile(iniPath, "utf8")).toBe("foreign-reappeared-registration");
        expect(await listOwnedAndroidAvdArtifactsAsync(owner, { root })).toEqual([
            expect.objectContaining({ name, iniPath }),
        ]);
    });
});
