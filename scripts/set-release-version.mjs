import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = process.argv[2];
const numeric = "(?:0|[1-9][0-9]*)";
const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^(${numeric})\\.(${numeric})\\.(${numeric})(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
function validVersion(value) {
    if (typeof value !== "string" || value.length > 256 || value.trim() !== value) return false;
    const match = semver.exec(value);
    return match !== null && match.slice(1, 4).every(part => Number.isSafeInteger(Number(part)));
}
assert(process.argv.length === 3 && validVersion(version),
    "Usage: node scripts/set-release-version.mjs <semver>");

const packages = [
    { directory: "", name: "claude-code-container", pins: { devDependencies: ["@ccc/device-lab", "@ccc/hyper-v"] } },
    { directory: "packages/device-lab", name: "@ccc/device-lab", pins: { dependencies: ["@ccc/hyper-v"] } },
    { directory: "packages/hyper-v", name: "@ccc/hyper-v", pins: {} },
    { directory: "device-lab-mcp", name: "@ccc/device-lab-mcp", pins: { dependencies: ["@ccc/device-lab"] } },
];
const manifests = packages.map(pkg => ({ ...pkg,
    file: join(root, pkg.directory, "package.json"),
    manifest: JSON.parse(readFileSync(join(root, pkg.directory, "package.json"), "utf8")),
}));
const lockFile = join(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockFile, "utf8"));
function validate(record, pkg) {
    assert(record && record.name === pkg.name && validVersion(record.version),
        `Invalid release package: ${pkg.name}`);
    for (const [section, names] of Object.entries(pkg.pins)) {
        for (const name of names) assert(validVersion(record[section]?.[name]),
            `Missing exact release dependency: ${pkg.name} -> ${name}`);
    }
}
assert(lock && lock.name === packages[0].name && lock.lockfileVersion === 3
    && validVersion(lock.version), "Invalid release lockfile");
for (const pkg of manifests) {
    validate(pkg.manifest, pkg);
    validate(lock.packages?.[pkg.directory], pkg);
    if (pkg.directory) {
        const link = lock.packages?.[`node_modules/${pkg.name}`];
        assert(link?.link === true && link.resolved === pkg.directory, `Invalid workspace link: ${pkg.name}`);
    }
}

// Validate the complete release topology before changing any manifest or lockfile.
function synchronize(record, pkg) {
    record.version = version;
    for (const [section, names] of Object.entries(pkg.pins)) {
        for (const name of names) record[section][name] = version;
    }
}
for (const pkg of manifests) {
    synchronize(pkg.manifest, pkg);
    synchronize(lock.packages[pkg.directory], pkg);
}
lock.version = version;
const outputs = [...manifests.map(pkg => [pkg.file, pkg.manifest]), [lockFile, lock]]
    .map(([file, value]) => [file, JSON.stringify(value, null, 2) + "\n"]);
for (const [file, content] of outputs) {
    if (readFileSync(file, "utf8") !== content) writeFileSync(file, content);
}
