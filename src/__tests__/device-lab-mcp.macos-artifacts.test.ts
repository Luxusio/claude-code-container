import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    materializeMacosSshAskpass,
    writeMacosGuestHelper,
} from "../../device-lab-mcp/src/backends/macos-vm.mjs";

describe("device-lab MCP direct macOS executable artifacts", () => {
    let home: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        home = mkdtempSync(join(tmpdir(), "ccc-macos-artifacts-"));
        process.env.HOME = home;
    });

    afterEach(() => {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(home, { recursive: true, force: true });
    });

    it("installs exact single-link executable artifacts", () => {
        const device = { id: "macos-test" };
        const askpass = materializeMacosSshAskpass(device);
        const helper = writeMacosGuestHelper(device);

        expect(readFileSync(askpass, "utf8")).toBe("#!/bin/sh\nprintf '%s\\n' \"$CCC_MACOS_SSH_PASSWORD\"\n");
        expect(readFileSync(helper, "utf8")).toContain("ccc macOS guest helper for macos-test");
        for (const path of [askpass, helper]) {
            const stat = lstatSync(path);
            expect(stat.isFile()).toBe(true);
            expect(stat.isSymbolicLink()).toBe(false);
            expect(stat.nlink).toBe(1);
            if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o700);
        }
    });

    it.runIf(process.platform !== "win32")("replaces final artifact symlinks without mutating their targets", () => {
        const device = { id: "macos-test" };
        const askpass = materializeMacosSshAskpass(device);
        const external = join(home, "external-script.sh");
        writeFileSync(external, "preserve");
        rmSync(askpass);
        symlinkSync(external, askpass);

        materializeMacosSshAskpass(device);

        expect(readFileSync(external, "utf8")).toBe("preserve");
        expect(lstatSync(askpass).isSymbolicLink()).toBe(false);
        expect(readFileSync(askpass, "utf8")).toContain("CCC_MACOS_SSH_PASSWORD");
    });

    it.runIf(process.platform !== "win32")("refuses linked workspace parents without mutating their targets", () => {
        const external = join(home, "external");
        const marker = join(external, "preserve.txt");
        mkdirSync(external);
        writeFileSync(marker, "preserve");
        symlinkSync(external, join(home, ".ccc"));

        expect(() => materializeMacosSshAskpass({ id: "macos-test" })).toThrow("macos-workspace-directory-invalid");
        expect(readdirSync(external)).toEqual(["preserve.txt"]);
        expect(readFileSync(marker, "utf8")).toBe("preserve");
    });

    it("rejects device ids that escape the owner workspace namespace", () => {
        expect(() => materializeMacosSshAskpass({ id: "../../outside" })).toThrow("macos-workspace-device-id-invalid");
    });

    it("preserves a colliding temporary artifact owned by another process", () => {
        const randomId = "a".repeat(32);
        const askpass = materializeMacosSshAskpass({ id: "macos-test" });
        const collision = join(dirname(askpass), `.ssh-askpass.sh.${randomId}.tmp`);
        writeFileSync(collision, "preserve");

        expect(() => materializeMacosSshAskpass(
            { id: "macos-test" },
            { randomId: () => randomId },
        )).toThrow("macos-artifact-create-failed");
        expect(readFileSync(collision, "utf8")).toBe("preserve");
    });
});
