import { describe, it, expect } from 'vitest';
import {
    hashPath,
    DATA_DIR,
    CLAUDE_DIR,
    REMOTE_CONFIG_DIR,
    IMAGE_NAME,
    CONTAINER_PID_LIMIT,
    COMMON_IGNORE_DIRS,
    MISE_VOLUME_NAME
} from '../utils.js';
import { homedir } from 'os';
import { join } from 'path';

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
});
