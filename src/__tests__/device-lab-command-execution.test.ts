import { describe, expect, it } from "vitest";
import { run } from "../../device-lab-mcp/src/commands.mjs";

describe("device-lab provider command execution bounds", () => {
    it("terminates a provider command at its configured deadline", () => {
        const startedAt = Date.now();
        const result = run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 50 });

        expect(result.status).toBeNull();
        expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
        expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    it("terminates a provider command that exceeds its output budget", () => {
        const result = run(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024 * 1024))"], {
            maxBuffer: 1024,
            timeout: 5000,
        });

        expect(result.status).toBeNull();
        expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOBUFS");
    });
});
