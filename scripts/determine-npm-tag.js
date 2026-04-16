#!/usr/bin/env node

// Determine npm dist-tag for publishing.
// Usage: node scripts/determine-npm-tag.js <new-version> <latest-version>
// Output: "latest" or "old"

/**
 * Compare two semver version strings (major.minor.patch).
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
export function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Determine the npm dist-tag.
 * Returns "latest" if newVersion >= latestVersion, otherwise "old".
 */
export function determineNpmTag(newVersion, latestVersion) {
    return compareVersions(newVersion, latestVersion) >= 0 ? 'latest' : 'old';
}

// CLI entry point — only when invoked directly
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [newVersion, latestVersion] = process.argv.slice(2);
    if (!newVersion || !latestVersion) {
        console.error('Usage: node determine-npm-tag.js <new-version> <latest-version>');
        process.exit(1);
    }
    process.stdout.write(determineNpmTag(newVersion, latestVersion));
}
