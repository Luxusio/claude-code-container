import { describe, it, expect } from 'vitest';
import { compareVersions, determineNpmTag } from '../../scripts/determine-npm-tag.js';

describe('compareVersions', () => {
    it('returns positive when a > b (patch)', () => {
        expect(compareVersions('1.0.3', '1.0.2')).toBeGreaterThan(0);
    });

    it('returns positive when a > b (minor)', () => {
        expect(compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0);
    });

    it('returns positive when a > b (major)', () => {
        expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    });

    it('returns 0 when versions are equal', () => {
        expect(compareVersions('1.0.2', '1.0.2')).toBe(0);
    });

    it('returns negative when a < b (patch)', () => {
        expect(compareVersions('1.0.1', '1.0.2')).toBeLessThan(0);
    });

    it('returns negative when a < b (major)', () => {
        expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    });

    it('handles multi-digit version segments', () => {
        expect(compareVersions('10.20.30', '10.20.29')).toBeGreaterThan(0);
    });

    it('handles zero versions', () => {
        expect(compareVersions('0.0.0', '0.0.0')).toBe(0);
    });
});

describe('determineNpmTag', () => {
    it('returns "latest" when new version > current latest', () => {
        expect(determineNpmTag('1.0.3', '1.0.2')).toBe('latest');
    });

    it('returns "latest" when versions are equal (re-publish)', () => {
        expect(determineNpmTag('1.0.2', '1.0.2')).toBe('latest');
    });

    it('returns "old" when new version < current latest', () => {
        expect(determineNpmTag('1.0.1', '1.0.2')).toBe('old');
    });

    it('returns "latest" for first publish (0.0.0 fallback)', () => {
        expect(determineNpmTag('1.0.0', '0.0.0')).toBe('latest');
    });

    it('returns "old" for old major line', () => {
        expect(determineNpmTag('1.0.0', '2.0.0')).toBe('old');
    });

    it('returns "latest" for minor bump', () => {
        expect(determineNpmTag('1.1.0', '1.0.9')).toBe('latest');
    });
});
