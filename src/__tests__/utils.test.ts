import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    hashPath,
    getProjectId,
    DATA_DIR,
    CLAUDE_DIR,
    CLAUDE_JSON_FILE,
    REMOTE_CONFIG_DIR,
    IMAGE_NAME,
    CONTAINER_PID_LIMIT,
    COMMON_IGNORE_DIRS,
    MISE_VOLUME_NAME,
    EXCLUDE_ENV_KEYS,
    CONTAINER_ENV_KEY,
    CONTAINER_ENV_VALUE,
    prompt,
} from '../utils.js';
import { homedir } from 'os';
import { join } from 'path';

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
    it('DATA_DIR should be ~/.ccc', () => {
        expect(DATA_DIR).toBe(join(homedir(), '.ccc'));
    });

    it('CLAUDE_DIR should be ~/.ccc/claude', () => {
        expect(CLAUDE_DIR).toBe(join(homedir(), '.ccc', 'claude'));
    });

    it('REMOTE_CONFIG_DIR should be ~/.ccc/remote', () => {
        expect(REMOTE_CONFIG_DIR).toBe(join(homedir(), '.ccc', 'remote'));
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

    it('excludes locale vars', () => {
        expect(EXCLUDE_ENV_KEYS.has('LC_ALL')).toBe(true);
        expect(EXCLUDE_ENV_KEYS.has('LC_CTYPE')).toBe(true);
        expect(EXCLUDE_ENV_KEYS.has('LANG')).toBe(true);
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

describe('additional constants', () => {
    it('CLAUDE_JSON_FILE should be ~/.ccc/claude.json', () => {
        expect(CLAUDE_JSON_FILE).toBe(join(homedir(), '.ccc', 'claude.json'));
    });

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
});
