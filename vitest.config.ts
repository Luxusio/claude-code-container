import { defineConfig } from 'vitest/config'
import { availableParallelism } from 'os'

const maxWorkers = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))

export default defineConfig({
    test: {
        // The repo's own tests, and only those. Without this vitest walks the whole working tree and
        // collects any *.test.ts it finds — including untracked scratch directories a developer
        // happens to have beside the source. That is how `claudep/` came to contribute two failures
        // to `npm test` on this machine: it is not a repo file (`git ls-files claudep` is empty, and
        // it sits in .git/info/exclude), but being git-ignored has never affected what vitest walks.
        //
        // Both entries are where `git ls-files '*.test.ts'` actually reports tests. A third location
        // means adding it here, which is the intended cost: the suite should be a property of the
        // repository rather than of whatever else happens to be in the directory.
        // Extensions matter here: scripts/real-tests holds .test.mjs as well as .test.ts, and an
        // earlier version of this list matched only .ts — which silently dropped
        // hyper-v-windows-library-elevation.test.mjs from the suite. Scoping collection is exactly
        // the change that can hide a test, so the pattern is checked against
        // `git ls-files` rather than written from memory.
        include: [
            "src/__tests__/**/*.test.?(m|c)[jt]s",
            "scripts/real-tests/**/*.test.?(m|c)[jt]s",
        ],
        globals: true,
        setupFiles: ['./scripts/real-tests/hidden-child-processes.cjs'],
        maxWorkers,
        testTimeout: 30000,
        hookTimeout: 60000,
    },
})
