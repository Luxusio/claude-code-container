# Workspace release version synchronization

CCC releases the root CLI and its three workspace packages as one versioned unit. Before dependency installation, compilation, packaging, Docker build or publication in each tagged release job, the release version must be applied to all four package manifests and their root lockfile records.

| Manifest | Package name | Exact internal pins |
| --- | --- | --- |
| `package.json` | `claude-code-container` | `devDependencies`: `@ccc/device-lab`, `@ccc/hyper-v` |
| `packages/device-lab/package.json` | `@ccc/device-lab` | `dependencies`: `@ccc/hyper-v` |
| `packages/hyper-v/package.json` | `@ccc/hyper-v` | None |
| `device-lab-mcp/package.json` | `@ccc/device-lab-mcp` | `dependencies`: `@ccc/device-lab` |

`node scripts/set-release-version.mjs <semver>` accepts exactly one version argument and locates these files relative to its own script. It accepts strict SemVer, including prerelease and build metadata, with at most 256 characters and major, minor and patch values no greater than `Number.MAX_SAFE_INTEGER`. Whitespace, invalid syntax, leading zeroes where SemVer forbids them, extra arguments and missing arguments are refusals. Numeric prerelease identifiers may exceed the safe integer range within the length limit.

Before writing, the helper reads all four manifests and `package-lock.json`, then validates the expected package names, valid existing versions, exact SemVer internal dependency pins, lockfile version 3, lockfile name and version, all four package records and the three workspace links. Each link must retain `link: true` and the expected workspace directory. Missing files, invalid JSON or invalid topology produce a nonzero exit without changing any input file.

After validation, the helper assigns the requested version to every manifest, lockfile package record, internal pin and top-level lockfile version. It preserves unrelated JSON data and workspace links. It serializes the five JSON files with two-space indentation and a final newline, and skips writes whose contents are already equal. Valid but differing old versions are synchronized by the same operation.

Each release job requires a `refs/tags/v` reference and a Docker-compatible tag before invoking the helper. References and versions are quoted environment values, never interpolated shell source. The helper must succeed before a version output is published or any consumer starts. Docker tags cannot contain SemVer build metadata, so the tagged Docker/npm workflow rejects those versions even though the standalone helper accepts them. The release version commit includes all four manifests and the root lockfile.

Local verification uses real CLI child processes against isolated fixtures for accepted versions, idempotence, preserved unrelated data and refusal before writes. The three actual workflow fragments are checked separately. Existing workspace archive and Unix materialization smoke must prove that the synchronized release ships matching root, embedded device-lab, Hyper-V and MCP metadata together with the public CLI/MCP surface. Helper-only fixture results do not prove packaging or shipping, and local verification does not authorize executing the hosted release workflow.

## Known ceiling

Known ceiling: Sequential writes can partially fail on I/O — upgrade if used for nondisposable user state.

The five writes are sequential filesystem operations, not a transaction. An I/O failure after validation produces a nonzero exit and may leave a partially updated disposable checkout. Recover from a clean checkout before retrying publication; a transactional writer is warranted only if this helper is later used to mutate nondisposable user state.
