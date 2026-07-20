import { describe, expect, it } from "vitest";
import { run } from "../../scripts/real-tests/level2-real-linux-vm.ts";

const level = Number(process.env.CCC_TEST_LEVEL || "0");

describe.runIf(level >= 2)("level 2 device-lab Linux VM integration", () => {
    it("runs through the public device-lab MCP", async () => {
        const result = await run();
        expect(["PASS", "SKIP"]).toContain(result.status);
        if (result.status === "SKIP") expect(result.reason).toBeTruthy();
    });
});
