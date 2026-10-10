import { describe, expect, it } from "vitest";
import { createCodexHarness } from "../../application/codex-harness.js";
import type { CodexHarnessPorts } from "../../ports/codex-harness.js";

describe("Codex Harness complete synchronous host policy", () => {

    it("constructs without invoking native effects", () => {
        const effect = () => { throw new Error("unexpected effect"); };
        expect(createCodexHarness({withConfigLock:effect,prepareConfig:effect,executeBootstrap:effect,restoreAccess:effect,publishBootstrapOutput:effect,publishUnavailable:effect}).ensure).toBeTypeOf("function");
    });
    it.each(["withConfigLock", "prepareConfig", "executeBootstrap", "restoreAccess", "publishBootstrapOutput", "publishUnavailable"])("rejects an absent or noncallable required binding: %s", name => {
        const all = Object.fromEntries(["withConfigLock", "prepareConfig", "executeBootstrap", "restoreAccess", "publishBootstrapOutput", "publishUnavailable"].map(key => [key, () => undefined]));
        delete all[name];
        expect(() => createCodexHarness(all as unknown as CodexHarnessPorts)).toThrow(TypeError);
        all[name] = 1 as unknown as () => undefined;
        expect(() => createCodexHarness(all as unknown as CodexHarnessPorts)).toThrow(TypeError);
    });
});
