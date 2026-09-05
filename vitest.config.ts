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
        include: ["src/__tests__/**/*.test.ts", "scripts/real-tests/**/*.test.ts"],
        globals: true,
        setupFiles: ['./scripts/real-tests/hidden-child-processes.cjs'],
        maxWorkers,
        testTimeout: 30000,
        hookTimeout: 60000,
    },
})
