import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    hashPath,
    getProjectId,
    projectIdentityPath,
    DATA_DIR,
    IMAGE_NAME,
    CONTAINER_PID_LIMIT,
    COMMON_IGNORE_DIRS,
    MISE_VOLUME_NAME,
    EXCLUDE_ENV_KEYS,
    CONTAINER_ENV_KEY,
    CONTAINER_ENV_VALUE,
    prompt,
    collectForwardedEnv,
    DEFAULT_ENV_FORWARD_BYTE_LIMIT,
    isValidEnvKey,
    getClaudeDir,
    getClaudeJsonFile,
    getCodexDir,
    getCodexConfigFile,
    writeEnvFile,
    writeOwnedEnvFile,
} from '../utils.js';
import { homedir, tmpdir } from 'os';
import { mkdtempSync, readFileSync, statSync, existsSync, unlinkSync, rmSync, realpathSync } from 'fs';
import { join, basename, dirname } from 'path';

// Keep the native environment proxy: older suites replace process.env with snapshots.
const nativeProcessEnv = process.env;

// readline mock (hoisted at module level)
const mockQuestion = vi.fn();
const mockOn = vi.fn();
const mockClose = vi.fn();
const mockCreateInterface = vi.fn(() => ({
    question: mockQuestion,
    on: mockOn,
    close: mockClose,
}));
vi.mock('readline', () => ({
    createInterface: (...args: unknown[]) => mockCreateInterface(...args),
}));

describe('utils constants', () => {
    const originalEnv = { ...process.env };
    const temporaryHomes: string[] = [];
    const isolateHome = () => {
        const home = mkdtempSync(join(tmpdir(), 'ccc-utils-home-'));
        temporaryHomes.push(home);
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        expect(homedir()).toBe(home);
        return home;
    };

    afterEach(() => {
        // Keep Node's native environment object: os.homedir reads the native HOME.
        for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
    });

    it('DATA_DIR should be ~/.ccc', () => {
        expect(DATA_DIR).toBe(join(homedir(), '.ccc'));
    });

    it('IMAGE_NAME should be ccc', () => {
        expect(IMAGE_NAME).toBe('ccc');
    });

    it('CONTAINER_PID_LIMIT should be -1 (unlimited)', () => {
        expect(CONTAINER_PID_LIMIT).toBe('-1');
    });

    it('MISE_VOLUME_NAME should be ccc-mise-cache', () => {
        expect(MISE_VOLUME_NAME).toBe('ccc-mise-cache');
    });

    it('COMMON_IGNORE_DIRS should include standard directories', () => {
        expect(COMMON_IGNORE_DIRS).toContain('node_modules');
        expect(COMMON_IGNORE_DIRS).toContain('.git');
        expect(COMMON_IGNORE_DIRS).toContain('dist');
        expect(COMMON_IGNORE_DIRS).toContain('build');
    });

    it('uses the default profile credential paths on the host', () => {
        delete process.env.container;
        const home = isolateHome();
        const profileRoot = join(home, '.ccc', 'profiles', 'default');
        expect(getClaudeDir()).toBe(join(profileRoot, 'claude'));
        expect(getClaudeJsonFile()).toBe(join(profileRoot, 'claude.json'));
        expect(getCodexDir()).toBe(join(profileRoot, 'codex'));
        expect(getCodexConfigFile()).toBe(join(profileRoot, 'codex', 'config.toml'));
        expect(getClaudeDir('default')).toBe(join(profileRoot, 'claude'));
    });

    it('uses per-profile claude and codex paths for a named profile', () => {
        delete process.env.container;
        const home = isolateHome();
        const profileRoot = join(home, '.ccc', 'profiles', 'work');
        expect(getClaudeDir('work')).toBe(join(profileRoot, 'claude'));
        expect(getClaudeJsonFile('work')).toBe(join(profileRoot, 'claude.json'));
        expect(getCodexDir('work')).toBe(join(profileRoot, 'codex'));
        expect(getCodexConfigFile('work')).toBe(join(profileRoot, 'codex', 'config.toml'));
    });

    it('uses mounted credential paths inside a real ccc container', () => {
        process.env.container = CONTAINER_ENV_VALUE;
        delete process.env.VITEST;
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('VITEST_')) delete process.env[key];
        }

        expect(getClaudeDir()).toBe(join(homedir(), '.claude'));
        expect(getClaudeJsonFile()).toBe(join(homedir(), '.claude.json'));
        expect(getCodexDir()).toBe(join(homedir(), '.codex'));
        expect(getCodexConfigFile()).toBe(join(homedir(), '.codex', 'config.toml'));
    });

    it('keeps host-style credential paths inside Vitest even when container env is set', () => {
        process.env.container = CONTAINER_ENV_VALUE;
        process.env.VITEST_POOL_ID = '1';
        const home = isolateHome();
        const profileRoot = join(home, '.ccc', 'profiles', 'default');

        expect(getClaudeDir()).toBe(join(profileRoot, 'claude'));
        expect(getClaudeJsonFile()).toBe(join(profileRoot, 'claude.json'));
        expect(getCodexDir()).toBe(join(profileRoot, 'codex'));
        expect(getCodexConfigFile()).toBe(join(profileRoot, 'codex', 'config.toml'));
    });
});

describe('hashPath', () => {
    it('should return consistent hash for same path', () => {
        const hash1 = hashPath('/some/path');
        const hash2 = hashPath('/some/path');
        expect(hash1).toBe(hash2);
    });

    it('should return different hash for different paths', () => {
        const hash1 = hashPath('/path/one');
        const hash2 = hashPath('/path/two');
        expect(hash1).not.toBe(hash2);
    });

    it('should return 12 character hash', () => {
        const hash = hashPath('/some/path');
        expect(hash).toHaveLength(12);
    });

    it('should only contain hex characters', () => {
        const hash = hashPath('/some/path');
        expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('should handle empty string', () => {
        const hash = hashPath('');
        expect(hash).toHaveLength(12);
        expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('should handle unicode paths', () => {
        const hash = hashPath('/home/사용자/프로젝트');
        expect(hash).toHaveLength(12);
        expect(hash).toMatch(/^[a-f0-9]+$/);
    });
});

describe('getProjectId', () => {
    it('uses the legacy lexical resolved path as its durable identity', () => {
        const lexicalPath = '/logical/project/Repo';
        const resolver = vi.fn(() => lexicalPath);

        expect(projectIdentityPath('./repo', resolver)).toBe(lexicalPath);
        expect(getProjectId('./repo', resolver))
            .toBe(`repo-${hashPath(lexicalPath)}`);
        expect(resolver).toHaveBeenCalledWith('./repo');
    });

    it('does not derive its ID from canonical filesystem identity', () => {
        const lexicalPath = '/junction/project/Repo';
        const canonicalPath = '/physical/project/Repo';

        expect(getProjectId('./repo', () => lexicalPath))
            .toBe(`repo-${hashPath(lexicalPath)}`);
        expect(getProjectId('./repo', () => lexicalPath))
            .not.toBe(`repo-${hashPath(canonicalPath)}`);
    });

    it('generates name-hash format', () => {
        const result = getProjectId('/home/user/my-project');
        expect(result).toMatch(/^my-project-[a-f0-9]{12}$/);
    });

    it('lowercases directory name', () => {
        const result = getProjectId('/home/user/MyProject');
        expect(result).toMatch(/^myproject-[a-f0-9]{12}$/);
    });

    it('replaces special characters with hyphens', () => {
        const result = getProjectId('/home/user/My Project!');
        expect(result).toMatch(/^my-project--[a-f0-9]{12}$/);
    });

    it('handles dots in directory name', () => {
        const result = getProjectId('/home/user/my.project.v2');
        expect(result).toMatch(/^my-project-v2-[a-f0-9]{12}$/);
    });

    it('handles underscores in directory name', () => {
        const result = getProjectId('/home/user/my_project');
        expect(result).toMatch(/^my-project-[a-f0-9]{12}$/);
    });

    it('returns consistent IDs for same path', () => {
        const id1 = getProjectId('/home/user/project');
        const id2 = getProjectId('/home/user/project');
        expect(id1).toBe(id2);
    });

    it('returns different IDs for same name but different paths', () => {
        const id1 = getProjectId('/home/user1/project');
        const id2 = getProjectId('/home/user2/project');
        // Same name prefix but different hash
        expect(id1).not.toBe(id2);
        expect(id1.split('-').slice(0, -1).join('-')).toBe(id2.split('-').slice(0, -1).join('-'));
    });

    it('preserves existing hyphens', () => {
        const result = getProjectId('/home/user/my-cool-project');
        expect(result).toMatch(/^my-cool-project-[a-f0-9]{12}$/);
    });

    it('handles numeric-only directory names', () => {
        const result = getProjectId('/home/user/12345');
        expect(result).toMatch(/^12345-[a-f0-9]{12}$/);
    });
});

describe('EXCLUDE_ENV_KEYS', () => {
    it('is a Set', () => {
        expect(EXCLUDE_ENV_KEYS).toBeInstanceOf(Set);
    });

    it('excludes PATH', () => {
        expect(EXCLUDE_ENV_KEYS.has('PATH')).toBe(true);
    });

    it('excludes HOME', () => {
        expect(EXCLUDE_ENV_KEYS.has('HOME')).toBe(true);
    });

    it('excludes USER', () => {
        expect(EXCLUDE_ENV_KEYS.has('USER')).toBe(true);
    });

    it('excludes SHELL', () => {
        expect(EXCLUDE_ENV_KEYS.has('SHELL')).toBe(true);
    });

    it('excludes SSH_AUTH_SOCK', () => {
        expect(EXCLUDE_ENV_KEYS.has('SSH_AUTH_SOCK')).toBe(true);
    });

    it('excludes CLAUDE_CONFIG_DIR', () => {
        expect(EXCLUDE_ENV_KEYS.has('CLAUDE_CONFIG_DIR')).toBe(true);
    });

    it('forwards locale vars (not excluded) for host locale matching', () => {
        expect(EXCLUDE_ENV_KEYS.has('LC_ALL')).toBe(false);
        expect(EXCLUDE_ENV_KEYS.has('LC_CTYPE')).toBe(false);
        expect(EXCLUDE_ENV_KEYS.has('LANG')).toBe(false);
    });

    it('excludes macOS-specific vars', () => {
        expect(EXCLUDE_ENV_KEYS.has('XPC_SERVICE_NAME')).toBe(true);
        expect(EXCLUDE_ENV_KEYS.has('Apple_PubSub_Socket_Render')).toBe(true);
        expect(EXCLUDE_ENV_KEYS.has('__CF_USER_TEXT_ENCODING')).toBe(true);
    });

    it('excludes terminal vars', () => {
        expect(EXCLUDE_ENV_KEYS.has('TERM')).toBe(true);
        expect(EXCLUDE_ENV_KEYS.has('COLORTERM')).toBe(true);
        expect(EXCLUDE_ENV_KEYS.has('ITERM_SESSION_ID')).toBe(true);
    });

    it('does not exclude common user env vars', () => {
        expect(EXCLUDE_ENV_KEYS.has('API_KEY')).toBe(false);
        expect(EXCLUDE_ENV_KEYS.has('NODE_ENV')).toBe(false);
        expect(EXCLUDE_ENV_KEYS.has('DATABASE_URL')).toBe(false);
        expect(EXCLUDE_ENV_KEYS.has('AWS_ACCESS_KEY_ID')).toBe(false);
    });
});

describe('collectForwardedEnv', () => {
    it('keeps smaller env vars first when byte budget is tight', () => {
        const env = {
            BIG_CUSTOM: 'x'.repeat(120),
            SMALL_CUSTOM: 'ok',
            MID_CUSTOM: 'hello',
        };

        const result = collectForwardedEnv(env, { byteLimit: 80 });
        const forwardedKeys = result.forwarded.map(([key]) => key);

        expect(forwardedKeys).toContain('SMALL_CUSTOM');
        expect(forwardedKeys).toContain('MID_CUSTOM');
        expect(result.skippedDueToLimit).toContain('BIG_CUSTOM');
    });

    it('skips Windows-path env values and noisy shell prefixes', () => {
        const env = {
            GOOD_KEY: 'value',
            WIN_PATH: 'C:\\Users\\TestUser\\AppData\\Local',
            __MISE_SESSION: 'huge-state',
            'BASH_FUNC_test%%': '() {  echo hi',
        };

        const result = collectForwardedEnv(env);
        const forwardedKeys = result.forwarded.map(([key]) => key);

        expect(forwardedKeys).toContain('GOOD_KEY');
        expect(forwardedKeys).not.toContain('WIN_PATH');
        expect(forwardedKeys).not.toContain('__MISE_SESSION');
        expect(forwardedKeys).not.toContain('BASH_FUNC_test%%');
    });

    it('uses the default byte limit when none is provided', () => {
        const env = {
            SMALL: '1',
            LARGE: 'x'.repeat(DEFAULT_ENV_FORWARD_BYTE_LIMIT),
        };

        const result = collectForwardedEnv(env);

        expect(result.forwarded.map(([key]) => key)).toContain('SMALL');
        expect(result.skippedDueToLimit).toContain('LARGE');
    });
});

describe('isValidEnvKey', () => {
    it('accepts POSIX-compatible env keys', () => {
        expect(isValidEnvKey('OPENAI_API_KEY')).toBe(true);
    });

    it('rejects malformed env keys', () => {
        expect(isValidEnvKey('BASH_FUNC_test%%')).toBe(false);
        expect(isValidEnvKey('1INVALID')).toBe(false);
    });
});

describe('additional constants', () => {
    it('CONTAINER_ENV_KEY should be "container"', () => {
        expect(CONTAINER_ENV_KEY).toBe('container');
    });

    it('CONTAINER_ENV_VALUE should be "docker"', () => {
        expect(CONTAINER_ENV_VALUE).toBe('docker');
    });
});

describe('prompt', () => {
    beforeEach(() => {
        mockQuestion.mockReset();
        mockOn.mockReset();
        mockClose.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('returns trimmed user input', async () => {
        mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => {
            cb('  answer  ');
        });

        const result = await prompt('Enter value: ');
        expect(result).toBe('answer');
    });

    it('lowercases result when lowercase flag is true', async () => {
        mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => {
            cb('  HELLO World  ');
        });

        const result = await prompt('Enter value: ', true);
        expect(result).toBe('hello world');
    });

    it('does not lowercase result when lowercase flag is false (default)', async () => {
        mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => {
            cb('MixedCase');
        });

        const result = await prompt('Enter value: ');
        expect(result).toBe('MixedCase');
    });

    it('returns empty string when stream closes (close event)', async () => {
        // Simulate stream close: question never calls back, but 'close' fires
        mockQuestion.mockImplementation(() => {
            // does not call callback
        });
        mockOn.mockImplementation((event: string, cb: () => void) => {
            if (event === 'close') {
                cb();
            }
        });

        const result = await prompt('Enter value: ');
        expect(result).toBe('');
    });

    it('resolves with user answer even when rl.close() triggers close event synchronously', async () => {
        // Regression test: rl.close() inside question callback fires 'close' event synchronously.
        // resolve() must be called with the answer BEFORE rl.close(), or the close handler
        // would win the race and return "" instead of the actual answer.
        let closeHandler: (() => void) | undefined;
        mockOn.mockImplementation((event: string, cb: () => void) => {
            if (event === 'close') closeHandler = cb;
        });
        mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => {
            cb('n');
        });
        mockClose.mockImplementation(() => {
            closeHandler?.(); // simulate synchronous close event on rl.close()
        });

        const result = await prompt('Enter value: ', true);
        expect(result).toBe('n');
    });
});

describe('public env-file writers', () => {
    let root: string;
    let previousProcessEnv: NodeJS.ProcessEnv;
    beforeEach(() => {
        previousProcessEnv = process.env;
        process.env = nativeProcessEnv;
        root = mkdtempSync(join(tmpdir(), 'ccc-utils-env-'));
        vi.stubEnv('TMPDIR', root);
        vi.stubEnv('TMP', root);
        vi.stubEnv('TEMP', root);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        process.env = previousProcessEnv;
        rmSync(root, { recursive: true, force: true });
    });

    it('keeps legacy bytes, entry order, native temp naming and caller-owned deletion', () => {
        const baseline = process.listenerCount('exit');
        const path = writeEnvFile([
            ['SECOND', 'two=parts'], ['FIRST', ''], ['LF', 'a\nb'],
            ['CR', 'a\rb'], ['NUL', 'a\0b'], ['UNICODE', '봄'],
        ]);
        try {
            expect(typeof path).toBe('string');
            expect(realpathSync(dirname(path))).toBe(realpathSync(root));
            expect(basename(path)).toMatch(/^ccc-env-[a-f0-9]{12}$/);
            expect(readFileSync(path, 'utf8')).toBe('SECOND=two=parts\nFIRST=\nUNICODE=봄\n');
            if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
            expect(process.listenerCount('exit')).toBe(baseline);
        } finally { unlinkSync(path); }
        expect(existsSync(path)).toBe(false);
    });

    it('retains the empty-file trailing newline and exposes an owned facade', () => {
        const baseline = process.listenerCount('exit');
        const owned = writeOwnedEnvFile([]);
        try {
            expect(readFileSync(owned.path, 'utf8')).toBe('\n');
            expect(process.listenerCount('exit')).toBe(baseline + 1);
        } finally { owned.dispose(); }
        expect(existsSync(owned.path)).toBe(false);
        expect(process.listenerCount('exit')).toBe(baseline);
    });
});
