import { configDefaults, defineConfig } from 'vitest/config'
import { parseCLI } from 'vitest/node'
import { availableParallelism } from 'os'
import { fileURLToPath } from 'url'

const maxWorkers = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))
const realProvidersEnabled = Number(process.env.CCC_TEST_LEVEL || 0) >= 2
// Vitest's inline-project CLI overrides omit maxWorkers. Read its own CLI
// parser only at the real CLI entry, leaving programmatic config loads alone.
let ordinaryMaxWorkers = realProvidersEnabled && /(?:^|[\\/])vitest(?:\.mjs)?$/i.test(process.argv[1] || '')
    ? parseCLI(['vitest', ...process.argv.slice(2)], { allowUnknownOptions: true }).options.maxWorkers
    : undefined
if (realProvidersEnabled && process.env.VITEST_MAX_WORKERS) {
    ordinaryMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS, 10)
    if (!Number.isSafeInteger(ordinaryMaxWorkers) || ordinaryMaxWorkers < 1) throw new Error('VITEST_MAX_WORKERS must select at least one worker')
    // Vitest applies this environment override after fileParallelism:false,
    // defeating its one-worker limit. Apply it to the ordinary project instead.
    delete process.env.VITEST_MAX_WORKERS
}
const include = [
    'src/__tests__/**/*.test.?(m|c)[jt]s',
    'scripts/real-tests/**/*.test.?(m|c)[jt]s',
]
// These wrappers use native host resources; similarly named physical-device
// contract fixtures remain in the parallel ordinary suite.
const realProviderFiles = [
    'src/__tests__/device-lab.real-provider-readiness.test.ts',
    'src/__tests__/device-lab.real-host-integration.test.ts',
    'src/__tests__/device-lab.real-ios-e2e.test.ts',
    'src/__tests__/device-lab.real-android-emulator-e2e.test.ts',
    'src/__tests__/device-lab.real-macos-vm-e2e.test.ts',
    'src/__tests__/device-lab.real-windows-sandbox.test.ts',
    'src/__tests__/device-lab-mcp.real-linux-vm.test.ts',
    'src/__tests__/device-lab.real-destructive.test.ts',
]

export default defineConfig({
    // Workspace unit tests observe source edits, including in watch mode.
    // Distribution tests separately exercise compiled package exports.
    resolve: {
        alias: [
            { find: /^(?:@ccc\/device-lab|#device-lab)\/providers\/(.+)$/, replacement: fileURLToPath(new URL('./packages/device-lab/providers/', import.meta.url)) + '$1' },
            { find: /^(?:@ccc\/device-lab|#device-lab)\/(.+)\.js(\?.*)?$/, replacement: fileURLToPath(new URL('./packages/device-lab/src/', import.meta.url)) + '$1.ts$2' },
            { find: /^@ccc\/device-lab$/, replacement: fileURLToPath(new URL('./packages/device-lab/src/index.ts', import.meta.url)) },
            { find: /^(?:@ccc\/hyper-v|#hyper-v)\/powershell\/(.+)$/, replacement: fileURLToPath(new URL('./packages/hyper-v/powershell/', import.meta.url)) + '$1' },
            { find: /^(?:@ccc\/hyper-v|#hyper-v)\/(.+)\.js(\?.*)?$/, replacement: fileURLToPath(new URL('./packages/hyper-v/src/', import.meta.url)) + '$1.ts$2' },
            { find: /^(?:@ccc\/hyper-v|#hyper-v)\/(low-level|lifecycle)$/, replacement: fileURLToPath(new URL('./packages/hyper-v/src/', import.meta.url)) + '$1/index.ts' },
            { find: /^(?:@ccc\/hyper-v|#hyper-v)$/, replacement: fileURLToPath(new URL('./packages/hyper-v/src/index.ts', import.meta.url)) },
        ],
    },
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
        ...(realProvidersEnabled ? {
            // Root includes merge into child projects, so define them only here.
            projects: [
                {
                    extends: true,
                    test: {
                        name: 'ordinary', include,
                        exclude: [...configDefaults.exclude, ...realProviderFiles],
                        ...(ordinaryMaxWorkers === undefined ? {} : { maxWorkers: ordinaryMaxWorkers }),
                    },
                },
                {
                    extends: true,
                    test: {
                        name: 'native', include: realProviderFiles,
                        fileParallelism: false, maxWorkers: 1,
                        sequence: { groupOrder: 1 },
                    },
                },
            ],
        } : { include }),
        globals: true,
        setupFiles: ['./scripts/real-tests/hidden-child-processes.cjs', './scripts/test-temp-root.cjs'],
        maxWorkers,
        testTimeout: 30000,
        hookTimeout: 60000,
    },
})
