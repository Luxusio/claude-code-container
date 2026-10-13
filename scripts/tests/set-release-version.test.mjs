import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helperSource = fileURLToPath(new URL("../set-release-version.mjs", import.meta.url));
const manifests = [
    ["package.json", "", "claude-code-container", "devDependencies", ["@ccc/device-lab", "@ccc/hyper-v"]],
    ["packages/device-lab/package.json", "packages/device-lab", "@ccc/device-lab", "dependencies", ["@ccc/hyper-v"]],
    ["packages/hyper-v/package.json", "packages/hyper-v", "@ccc/hyper-v", "dependencies", []],
    ["device-lab-mcp/package.json", "device-lab-mcp", "@ccc/device-lab-mcp", "dependencies", ["@ccc/device-lab"]],
];
const inputPaths = [...manifests.map(([path]) => path), "package-lock.json"];

function initialFiles() {
    const files = {};
    const packages = {
        "node_modules/unrelated": { version: "9.0.0", resolved: "https://example.invalid/unrelated.tgz", integrity: "preserve" },
    };
    for (const [path, directory, name, field, pins] of manifests) {
        const manifest = {
            name, version: "1.1.90", license: "MIT", privateMetadata: { keep: ["nested", 7] },
            [field]: { unrelated: "^9.0.0", ...Object.fromEntries(pins.map(pin => [pin, "1.1.90"])) },
        };
        files[path] = manifest;
        packages[directory] = structuredClone(manifest);
        if (directory) packages[`node_modules/${name}`] = { resolved: directory, link: true, keep: "link metadata" };
    }
    files["package-lock.json"] = {
        name: "claude-code-container", version: "1.1.90", lockfileVersion: 3, requires: true, packages,
        privateMetadata: { keep: "lock metadata" },
    };
    return files;
}

function withFixture(run) {
    const root = mkdtempSync(join(tmpdir(), "ccc-release-version-"));
    try {
        const files = initialFiles();
        const writeJson = (path, value) => {
            const destination = join(root, path);
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(destination, JSON.stringify(value, null, 2) + "\n");
        };
        for (const [path, value] of Object.entries(files)) writeJson(path, value);
        const helper = join(root, "scripts", "set-release-version.mjs");
        mkdirSync(dirname(helper), { recursive: true });
        copyFileSync(helperSource, helper);
        const bytes = () => inputPaths.map(path => readFileSync(join(root, path)));
        const readJson = path => JSON.parse(readFileSync(join(root, path), "utf8"));
        const invoke = args => {
            const result = spawnSync(process.execPath, [helper, ...args], {
                cwd: root, encoding: "utf8", shell: false, windowsHide: true,
                timeout: 10_000, maxBuffer: 64 * 1024,
            });
            assert.equal(result.error, undefined, result.error?.message);
            assert.equal(typeof result.status, "number", result.stderr);
            assert.equal(result.signal, null, result.stderr);
            return result;
        };
        return run({ root, files, writeJson, bytes, readJson, invoke });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

for (const version of ["2.3.4", "2.3.4-rc.7", "2.3.4-rc.7+build.9"]) {
    test(`synchronizes the complete release unit to ${version} and is byte-idempotent`, () => withFixture(fixture => {
        const expected = structuredClone(fixture.files);
        const lock = expected["package-lock.json"];
        lock.version = version;
        for (const [path, directory, , field, pins] of manifests) {
            for (const record of [expected[path], lock.packages[directory]]) {
                record.version = version;
                for (const pin of pins) record[field][pin] = version;
            }
        }
        const first = fixture.invoke([version]);
        assert.equal(first.status, 0, first.stderr);
        for (const path of inputPaths) assert.deepEqual(fixture.readJson(path), expected[path], path);
        const synchronized = fixture.bytes();
        const second = fixture.invoke([version]);
        assert.equal(second.status, 0, second.stderr);
        assert.deepEqual(fixture.bytes(), synchronized);
    }));
}

test("accepts safe integer core and 256-character version boundaries", () => {
    for (const version of ["9007199254740991.2.3-9007199254740993123456789", "1.2.3+" + "a".repeat(250)]) {
        withFixture(fixture => {
            const result = fixture.invoke([version]);
            assert.equal(result.status, 0, result.stderr);
            for (const [path] of manifests) assert.equal(fixture.readJson(path).version, version);
            assert.equal(fixture.readJson("package-lock.json").version, version);
        });
    }
});

test("invalid arguments fail before changing any release file", () => {
    const rejected = [
        [], ["1.2.3", "2.3.4"], [""], ["v1.2.3"], ["1.2"], ["1.02.3"], ["1.2.3-01"],
        [" 1.2.3"], ["1.2.3 "], ["1.2.3\n"], ["9007199254740992.2.3"], ["1.2.3+" + "a".repeat(251)],
    ];
    for (const args of rejected) withFixture(fixture => {
        const before = fixture.bytes();
        const result = fixture.invoke(args);
        assert.notEqual(result.status, 0, `accepted ${JSON.stringify(args)}`);
        assert.deepEqual(fixture.bytes(), before, `changed files for ${JSON.stringify(args)}`);
    });
});

test("invalid later manifests, pins, lock records, and workspace links never partially update files", () => {
    const rejected = [
        ["unparseable last manifest", fixture => writeFileSync(join(fixture.root, "device-lab-mcp/package.json"), "{bad json")],
        ["wrong last package name", files => { files["device-lab-mcp/package.json"].name = "@ccc/other"; }],
        ["invalid last package version", files => { files["device-lab-mcp/package.json"].version = "1.02.3"; }],
        ["missing internal pin", files => { delete files["package.json"].devDependencies["@ccc/hyper-v"]; }],
        ["ranged last internal pin", files => { files["device-lab-mcp/package.json"].dependencies["@ccc/device-lab"] = "^1.1.90"; }],
        ["wrong lock root name", files => { files["package-lock.json"].name = "other"; }],
        ["unsupported lock version", files => { files["package-lock.json"].lockfileVersion = 2; }],
        ["missing last lock record", files => { delete files["package-lock.json"].packages["device-lab-mcp"]; }],
        ["wrong last lock record name", files => { files["package-lock.json"].packages["device-lab-mcp"].name = "@ccc/other"; }],
        ["ranged lock pin", files => { files["package-lock.json"].packages["packages/device-lab"].dependencies["@ccc/hyper-v"] = "~1.1.90"; }],
        ["wrong workspace link target", files => { files["package-lock.json"].packages["node_modules/@ccc/device-lab-mcp"].resolved = "packages/hyper-v"; }],
        ["workspace link not marked as link", files => { files["package-lock.json"].packages["node_modules/@ccc/hyper-v"].link = false; }],
    ];
    for (const [label, damage] of rejected) withFixture(fixture => {
        if (label === "unparseable last manifest") damage(fixture);
        else {
            damage(fixture.files);
            for (const [path, value] of Object.entries(fixture.files)) fixture.writeJson(path, value);
        }
        const before = fixture.bytes();
        const result = fixture.invoke(["2.0.0"]);
        assert.notEqual(result.status, 0, label);
        assert.deepEqual(fixture.bytes(), before, label);
    });
});
