// Bash-level test for scripts/ccc-entrypoint.sh.
//
// We drive the script through spawnSync against a per-test PATH that
// contains mock `iptables`, `id`, and `setpriv` shims. Each shim logs its
// invocation to a state file we can assert on, and reads its desired exit
// code from env vars the test sets — no real binaries are invoked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ENTRYPOINT = resolve(__dirname, '../../scripts/ccc-entrypoint.sh');

interface Fixture {
    dir: string;
    bin: string;
    stateFile: string;
    cleanup: () => void;
}

function makeFixture(): Fixture {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-entrypoint-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const stateFile = join(dir, 'state.txt');
    writeFileSync(stateFile, '');

    // Mock iptables — exit codes come from env. -C (check) returns
    // MOCK_CHECK_EXIT (default 1, meaning "rule not present"); -A (add)
    // returns the n-th entry of MOCK_ADD_EXITS (space-separated).
    writeFileSync(
        join(bin, 'iptables'),
        `#!/bin/bash
echo "iptables $*" >> "$MOCK_STATE"
is_check=false
for a in "$@"; do [ "$a" = "-C" ] && is_check=true && break; done
if [ "$is_check" = true ]; then exit "\${MOCK_CHECK_EXIT:-1}"; fi
add_count=$(grep -c -- ' -A ' "$MOCK_STATE" || true)
read -ra exits <<< "$MOCK_ADD_EXITS"
idx=$(( add_count - 1 ))
if [ "$idx" -ge "\${#exits[@]}" ]; then idx=$(( \${#exits[@]} - 1 )); fi
exit "\${exits[$idx]:-0}"
`,
    );
    chmodSync(join(bin, 'iptables'), 0o755);

    // Mock id — succeeds for ccc-proxy lookup unless MOCK_ID_FAIL=1.
    writeFileSync(
        join(bin, 'id'),
        `#!/bin/bash
if [ "\${MOCK_ID_FAIL:-0}" = "1" ]; then exit 1; fi
if [ "$1" = "-u" ] && [ "$2" = "ccc-proxy" ]; then echo 999; exit 0; fi
exit 1
`,
    );
    chmodSync(join(bin, 'id'), 0o755);

    // Mock sudo — strips -n / -u <user> flags and execs the rest. The real
    // sudo is what we'd use in-container; tests skip the privilege transition
    // because the container's iptables/daemon are stand-ins anyway.
    writeFileSync(
        join(bin, 'sudo'),
        `#!/bin/bash
while [ $# -gt 0 ]; do
    case "$1" in
        -n) shift;;
        -u) shift 2;;
        --) shift; break;;
        *) break;;
    esac
done
exec "$@"
`,
    );
    chmodSync(join(bin, 'sudo'), 0o755);

    // Dummy proxy daemon — exits immediately, just so the script has
    // something to fork.
    writeFileSync(join(bin, 'fake-proxy'), `#!/bin/bash\nexit 0\n`);
    chmodSync(join(bin, 'fake-proxy'), 0o755);

    return {
        dir,
        bin,
        stateFile,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

function runEntrypoint(
    fx: Fixture,
    env: Record<string, string>,
    args: string[] = ['echo', 'CMD_RAN'],
) {
    return spawnSync(
        'bash',
        [ENTRYPOINT, ...args],
        {
            env: {
                PATH: `${fx.bin}:/usr/bin:/bin`,
                MOCK_STATE: fx.stateFile,
                CCC_PROXY_DAEMON: join(fx.bin, 'fake-proxy'),
                CCC_IPTABLES_INITIAL_BACKOFF_MS: '1',
                ...env,
            },
            encoding: 'utf-8',
            timeout: 10_000,
        },
    );
}

describe('ccc-entrypoint.sh', () => {
    let fx: Fixture;

    beforeEach(() => {
        fx = makeFixture();
    });

    afterEach(() => {
        fx.cleanup();
    });

    it('skips iptables setup when CCC_PROXY_ENABLED is unset and execs the command', () => {
        const result = runEntrypoint(fx, {});

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('CMD_RAN');
        expect(result.stderr).toContain('skipping proxy setup');
        // No iptables calls.
        expect(readFileSync(fx.stateFile, 'utf-8')).not.toContain('iptables ');
    });

    it('adds iptables rule on first try and execs the command', () => {
        const result = runEntrypoint(fx, {
            CCC_PROXY_ENABLED: '1',
            MOCK_CHECK_EXIT: '1', // rule absent
            MOCK_ADD_EXITS: '0',
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('CMD_RAN');
        const state = readFileSync(fx.stateFile, 'utf-8');
        expect(state).toContain(' -A ');
        expect(state).toContain('REDIRECT');
        expect(result.stderr).toContain('iptables NAT rule added (attempt 1)');
    });

    it('skips add when rule is already present (idempotent restart)', () => {
        const result = runEntrypoint(fx, {
            CCC_PROXY_ENABLED: '1',
            MOCK_CHECK_EXIT: '0', // rule already present
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('CMD_RAN');
        const state = readFileSync(fx.stateFile, 'utf-8');
        expect(state).toContain(' -C ');
        expect(state).not.toContain(' -A '); // no add attempted
        expect(result.stderr).toContain('iptables NAT rule already present');
    });

    it('retries on lock-busy (exit 4) and succeeds on a later attempt', () => {
        const result = runEntrypoint(fx, {
            CCC_PROXY_ENABLED: '1',
            MOCK_CHECK_EXIT: '1',
            MOCK_ADD_EXITS: '4 4 0', // fail twice, then succeed
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('CMD_RAN');
        const state = readFileSync(fx.stateFile, 'utf-8');
        const addCount = (state.match(/ -A /g) ?? []).length;
        expect(addCount).toBe(3);
        expect(result.stderr).toContain('attempt 1 failed');
        expect(result.stderr).toContain('attempt 2 failed');
        expect(result.stderr).toContain('iptables NAT rule added (attempt 3)');
    });

    it('exits non-zero (container start fails) when iptables exhausts retries', () => {
        const result = runEntrypoint(fx, {
            CCC_PROXY_ENABLED: '1',
            MOCK_CHECK_EXIT: '1',
            MOCK_ADD_EXITS: '4 4 4',
        });

        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain('CMD_RAN');
        expect(result.stderr).toContain('iptables setup failed after 3 attempts');
    });

    it('exits non-zero when ccc-proxy user is missing', () => {
        const result = runEntrypoint(fx, {
            CCC_PROXY_ENABLED: '1',
            MOCK_ID_FAIL: '1',
        });

        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain('CMD_RAN');
        expect(result.stderr).toMatch(/user missing/);
    });

    it('always emits a one-line summary when proxy setup runs', () => {
        const result = runEntrypoint(fx, {
            CCC_PROXY_ENABLED: '1',
            MOCK_CHECK_EXIT: '1',
            MOCK_ADD_EXITS: '0',
        });

        expect(result.status).toBe(0);
        // Per-phase timing is gated on CCC_DEBUG_TIMING and stays quiet here.
        expect(result.stderr).not.toMatch(/\[timing\]/);
        // Summary is always shown so a regressing hang is immediately visible.
        expect(result.stderr).toMatch(/proxy setup complete in (\d+ms|\d+\.\d+s)/);
    });

    it('emits per-phase timing only when CCC_DEBUG_TIMING=1', () => {
        const result = runEntrypoint(fx, {
            CCC_PROXY_ENABLED: '1',
            CCC_DEBUG_TIMING: '1',
            MOCK_CHECK_EXIT: '1',
            MOCK_ADD_EXITS: '0',
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toMatch(/\[timing\] iptables_setup=/);
        expect(result.stderr).toMatch(/\[timing\] proxy_daemon=/);
    });

    it('every log line carries the [ccc-entrypoint] prefix for grep', () => {
        const result = runEntrypoint(fx, {
            CCC_PROXY_ENABLED: '1',
            CCC_DEBUG_TIMING: '1',
            MOCK_CHECK_EXIT: '1',
            MOCK_ADD_EXITS: '0',
        });

        const ourLines = result.stderr
            .split('\n')
            .filter((l) => l.trim().length > 0)
            // The mock daemon doesn't emit anything, but defensive filtering
            // here keeps the assertion stable if future scripts append output.
            .filter((l) => !l.startsWith('+ ') && !l.startsWith('CMD_RAN'));
        expect(ourLines.length).toBeGreaterThan(0);
        for (const line of ourLines) {
            expect(line.startsWith('[ccc-entrypoint]')).toBe(true);
        }
    });

});
