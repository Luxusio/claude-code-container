import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["scripts/real-tests/level3-vitest.ts"],
        setupFiles: ["./scripts/real-tests/hidden-child-processes.cjs"],
        fileParallelism: false,
        testTimeout: 10 * 60 * 60 * 1000,
        hookTimeout: 60 * 1000,
    },
});
