import { defineConfig } from 'vitest/config'
import { availableParallelism } from 'os'

const maxWorkers = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))

export default defineConfig({
    test: {
        globals: true,
        setupFiles: ['./scripts/real-tests/hidden-child-processes.cjs'],
        maxWorkers,
        testTimeout: 30000,
        hookTimeout: 60000,
    },
})
