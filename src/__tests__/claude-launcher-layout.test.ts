import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync, spawnSync } from "child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
    realpathSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { buildClaudeLauncherReportCommand, buildClaudeProbeScript, type ClaudeLayoutPaths } from "../container-setup.js"

// These run the generated script instead of matching substrings in it.
//
// That distinction is the whole point of this file. The predecessor asserted
// things like `expect(shCmd).toContain("cp -L ${CACHE} ${BIN}")` — which is a
// test that the script says what it says, not that it does what it should. It
// passed for the entire life of the bug it was supposed to guard: ccc wrote
// ~/.local/bin/claude as a regular file, the native updater refuses to manage a
// launcher it did not create, and so `claude update` reported success while
// every subsequent run executed the same stale binary.
//
// No Docker needed: the script is pure POSIX sh over paths, so pointing it at a
// temp directory exercises the real branches.

let root: string
let paths: ClaudeLayoutPaths

// PATH is pinned to the system directories on purpose. The script treats
// `command -v claude` as a migration donor, so with the ambient PATH these
// tests quietly adopted the developer's own ~/.local/bin/claude and every
// "nothing usable" case came back RESTORED. Isolating PATH is what makes the
// INSTALL branch reachable, and keeps the suite from depending on whether the
// machine running it happens to have claude installed.
function runWithEnv(env: Record<string, string>): { status: number, stdout: string } {
    try {
        const stdout = execFileSync("sh", ["-c", buildClaudeProbeScript(paths)], { encoding: "utf-8", env })
        return { status: 0, stdout: stdout.trim() }
    } catch (error) {
        const e = error as { status?: number, stdout?: string }
        return { status: e.status ?? -1, stdout: (e.stdout ?? "").trim() }
    }
}

function run(): { status: number, stdout: string, stderr: string } {
    // spawnSync rather than execFileSync: the latter surfaces stderr only on a
    // throw, so a diagnostic printed by a run that SUCCEEDS was invisible to
    // the tests — and a skipped entry that costs the user a reinstall is
    // exactly such a diagnostic.
    const result = spawnSync("sh", ["-c", buildClaudeProbeScript(paths)],
        { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } })
    return {
        status: result.status ?? -1,
        stdout: (result.stdout ?? "").trim(),
        stderr: (result.stderr ?? "").trim(),
    }
}

// A stand-in for the real 200MB binary: `is_claude` only ever reads the first
// line of `--version`, and `is_shim` only greps the first 500 bytes for "mise".
function writeFakeClaude(path: string, version: string): void {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version} (Claude Code)"\nexit 0\n`)
    chmodSync(path, 0o755)
}

// A mise shim forwards to the real binary, so it answers `--version` exactly
// like claude does. The fake must do the same, or `is_claude` rejects it and the
// `is_shim` guard is never the thing under test — a mutation removing that guard
// survived precisely because an earlier version of this helper failed to answer.
function writeMiseShim(path: string, version = "2.1.261"): void {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(
        path,
        `#!/bin/sh\n# exec ~/.local/bin/mise exec node@22 -- claude "$@"\n[ "$1" = "--version" ] && echo "${version} (Claude Code)"\nexit 0\n`,
    )
    chmodSync(path, 0o755)
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccc-claude-layout-"))
    mkdirSync(join(root, "bin"), { recursive: true })
    paths = {
        bin: join(root, "bin", "claude"),
        dataDir: join(root, "share", "claude"),
        volumeDataDir: join(root, "volume", ".claude-data"),
        legacyCacheFile: join(root, "volume", ".claude-bin", "claude"),
    }
})

// A bind mount needs no privileges inside a user namespace, so the mount-point
// guards are testable after all — the earlier claim that they were not is what
// let a data-destroying mutant survive. Skipped, not silently passed, where the
// kernel or the image will not give us one.
const canBindMount = (() => {
    try {
        // The failure path is the one that arms the skip, so the cleanup has to
        // survive it. It does not probe /proc/self/mountinfo, which the guard
        // itself reads: where /proc is masked this reports "can mount" and the
        // test fails rather than skipping.
        const probe = mkdtempSync(join(tmpdir(), "ccc-bindmount-probe-"))
        try {
            mkdirSync(join(probe, "a"))
            mkdirSync(join(probe, "b"))
            execFileSync("unshare", ["-Umr", "sh", "-c", `mount --bind '${join(probe, "a")}' '${join(probe, "b")}'`],
                { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } })
        } finally {
            rmSync(probe, { recursive: true, force: true })
        }
        return true
    } catch {
        return false
    }
})()

// Nothing published into the shared volume may be a symlink: it would point at
// a path that exists only in the container that wrote it.
function volumeSymlinks(): string[] {
    const out: string[] = []
    const walk = (dir: string) => {
        if (!existsSync(dir)) return
        for (const name of readdirSync(dir)) {
            const full = join(dir, name)
            const st = lstatSync(full)
            if (st.isSymbolicLink()) out.push(full)
            else if (st.isDirectory()) walk(full)
        }
    }
    walk(paths.volumeDataDir)
    return out
}

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

describe("claude launcher layout", () => {
    describe("data directory placement", () => {
        it("points the XDG data dir at the persistent volume", () => {
            run()

            expect(lstatSync(paths.dataDir).isSymbolicLink()).toBe(true)
            expect(readlinkSync(paths.dataDir)).toBe(paths.volumeDataDir)
        })

        it("does not create the version directory it just refused", () => {
            // The refusal was announced and then undone one entry later: the
            // deeper path took the mirror branch, mkdir -p recreated the name,
            // and the shared volume ended up holding exactly the state the
            // message said was refused.
            mkdirSync(join(paths.dataDir, "versions", "2.1.261", "sub"), { recursive: true })
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.261", "sub", "claude"), "2.1.261")

            const result = run()

            expect(result.status).not.toBe(0)
            expect(existsSync(join(paths.volumeDataDir, "versions", "2.1.261"))).toBe(false)
        })

        it("refuses to publish a directory under a version name", () => {
            // Mirroring a container's own broken state into the shared volume
            // takes that version name out of circulation for every project on
            // the host: pick_best skips it, seed_from refuses it, adopt skips
            // it — while still deleting each container's good copy.
            mkdirSync(join(paths.dataDir, "versions", "2.1.261"), { recursive: true })
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.261", "claude"), "2.1.261")

            const result = run()

            expect(result.status).not.toBe(0)
            expect(existsSync(join(paths.volumeDataDir, "versions", "2.1.261"))).toBe(false)
        })

        it("does not empty a shared directory to make room for an entry", () => {
            // Measured against the first version of the clearing rule, which
            // reported `RESTORED 2.1.300` after deleting every version the
            // volume held. `versions` is a directory on our side in every
            // normal install, so the loop mirrors it and never reaches the
            // clearing branch — but as a SYMLINK it is a leaf, `$target`
            // becomes the volume's whole `versions` directory, and `rm -rf`
            // takes out what every other project on the host is running.
            //
            // Clearing a name is only ever safe for something that holds
            // nothing. A non-empty directory is refused, and refusing here
            // costs this container a start it could not have completed anyway.
            const volVersions = join(paths.volumeDataDir, "versions")
            mkdirSync(volVersions, { recursive: true })
            writeFakeClaude(join(volVersions, "2.1.100"), "2.1.100")
            writeFakeClaude(join(volVersions, "2.1.261"), "2.1.261")
            const elsewhere = join(root, "elsewhere")
            writeFakeClaude(join(elsewhere, "2.1.300"), "2.1.300")
            mkdirSync(paths.dataDir, { recursive: true })
            symlinkSync(elsewhere, join(paths.dataDir, "versions"))

            const result = run()

            expect(existsSync(join(volVersions, "2.1.100"))).toBe(true)
            expect(existsSync(join(volVersions, "2.1.261"))).toBe(true)
            // Enumerating with -L dissolves the case rather than defending
            // against it: versions/ is the directory it points at, so it is
            // mirrored and its versions are copied in as files. The shared
            // directory is never a leaf, so it is never a removal target.
            expect(result.status).toBe(0)
            expect(lstatSync(join(volVersions, "2.1.300")).isFile()).toBe(true)
            expect(volumeSymlinks()).toEqual([])
        })

        it("never publishes a symlink into the shared volume", () => {
            // A symlink published there points at a path that exists only in
            // the container that wrote it, so every other container reads a
            // dangling name — and no later run can free it, because our own
            // side is a directory and never reaches the clearing branch.
            mkdirSync(paths.dataDir, { recursive: true })
            const elsewhere = join(root, "elsewhere")
            writeFakeClaude(join(elsewhere, "2.1.300"), "2.1.300")
            symlinkSync(elsewhere, join(paths.dataDir, "versions"))
            writeFakeClaude(join(root, "outside", "blob"), "0.0.1")
            symlinkSync(join(root, "outside", "blob"), join(paths.dataDir, "statsig"))

            const result = run()

            expect(result.status).toBe(0)
            expect(volumeSymlinks()).toEqual([])
            expect(lstatSync(join(paths.volumeDataDir, "statsig")).isFile()).toBe(true)
        })

        it.skipIf(!canBindMount)("refuses to replace a data directory that is a mount point", () => {
            // The oldest of the three guards, and until now the only family
            // member with no test — not because a mount was unobtainable, which
            // this document once claimed, but because nobody had written it.
            mkdirSync(paths.dataDir, { recursive: true })
            const source = join(root, "mounted-data")
            mkdirSync(source, { recursive: true })
            writeFileSync(join(source, "precious"), "the other side of the mount")

            const script = join(root, "probe.sh")
            writeFileSync(script, buildClaudeProbeScript(paths))
            let stderr = ""
            try {
                execFileSync("unshare", ["-Umr", "sh", "-c",
                    `mount --bind '${source}' '${paths.dataDir}' && sh '${script}'`],
                    { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } })
            } catch (error) {
                stderr = ((error as { stderr?: string }).stderr ?? "")
            }

            expect(readFileSync(join(source, "precious"), "utf8")).toBe("the other side of the mount")
            expect(stderr).toContain("refusing to replace")
            expect(stderr).toContain(paths.dataDir)
            expect(existsSync(paths.bin)).toBe(false)
        })

        it("does not copy a version the volume already holds", () => {
            // The skip before staging looks redundant with the one inside the
            // clearing block — same condition, same outcome — so removing it
            // passed the whole suite. The difference is 215MB of copying per
            // already-present version on every start, and it is only visible
            // when the volume cannot be written to at all: with the skip there
            // is nothing to write, without it the staging copy is attempted
            // and the start fails.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.261"), "2.1.261")
            const volVersions = join(paths.volumeDataDir, "versions")
            mkdirSync(volVersions, { recursive: true })
            writeFakeClaude(join(volVersions, "2.1.261"), "2.1.261")
            chmodSync(volVersions, 0o555)
            chmodSync(paths.volumeDataDir, 0o555)

            const result = run()

            chmodSync(paths.volumeDataDir, 0o755)
            chmodSync(volVersions, 0o755)
            expect(result.status).toBe(0)
            expect(result.stdout).toBe("RESTORED 2.1.261")
        })

        it.skipIf(!canBindMount)("refuses to clear through a bind mount at a version name", () => {
            // rm -rf deletes the contents THROUGH the mount before it fails
            // EBUSY on the directory itself, so without the guard the user's
            // data is gone while the exit code and stderr look identical. That
            // is why this needs a real mount rather than a reasoned argument.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.261"), "2.1.261")
            const junk = join(paths.volumeDataDir, "versions", "2.1.261")
            mkdirSync(junk, { recursive: true })
            const source = join(root, "mounted")
            mkdirSync(source, { recursive: true })
            writeFileSync(join(source, "precious"), "the other side of the mount")

            const script = join(root, "probe.sh")
            writeFileSync(script, buildClaudeProbeScript(paths))
            let stderr = ""
            try {
                execFileSync("unshare", ["-Umr", "sh", "-c",
                    `mount --bind '${source}' '${junk}' && sh '${script}'`],
                    { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } })
            } catch (error) {
                stderr = ((error as { stderr?: string }).stderr ?? "")
            }

            expect(readFileSync(join(source, "precious"), "utf8")).toBe("the other side of the mount")
            // "mount point" alone is satisfied by mount's own failure text
            // ("mount point does not exist"), which would let a mount that
            // never happened pass all three assertions.
            expect(stderr).toContain("cannot adopt versions/2.1.261")
            expect(stderr).toContain("mount point")
            expect(stderr).not.toContain("RESTORED")
        })

        it("refuses a non-empty directory at a name that is not a version", () => {
            // The recursive clear is licensed by what a version name means, not
            // by convenience: only versions/<v> is junk by construction. Every
            // other name in the volume may hold something another project put
            // there, and ccc cannot tell the difference — so it refuses rather
            // than deleting. Without this, widening the cautious branch to a
            // recursive delete passes the whole suite while destroying shared
            // state and reporting success.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.261"), "2.1.261")
            writeFileSync(join(paths.dataDir, "statsig"), "local")
            const shared = join(paths.volumeDataDir, "statsig")
            mkdirSync(shared, { recursive: true })
            writeFileSync(join(shared, "cache.json"), "shared state")

            const result = run()

            expect(result.status).not.toBe(0)
            expect(readFileSync(join(shared, "cache.json"), "utf8")).toBe("shared state")
            expect(existsSync(join(paths.dataDir, "statsig"))).toBe(true)
        })

        it("refuses to publish over the versions directory itself", () => {
            // A regular file at that name is a wedge nothing can undo: once the
            // data dir is the symlink, this loop is never entered again, so no
            // later run can clear it — for any project on the host.
            mkdirSync(paths.dataDir, { recursive: true })
            writeFileSync(join(paths.dataDir, "versions"), "not a directory")
            mkdirSync(join(paths.volumeDataDir, "versions"), { recursive: true })

            const result = run()

            expect(result.status).not.toBe(0)
            expect(lstatSync(join(paths.volumeDataDir, "versions")).isDirectory()).toBe(true)
        })

        it("clears a junk directory under a version name even when it is not empty", () => {
            // versions/<v> as a directory is junk by construction — the mirror
            // branch refuses to create one, pick_best skips it, seed_from
            // refuses it — so nothing anyone runs lives inside. Refusing it
            // left a container with a perfectly good local install failing on
            // every start forever, which is the failure this whole rule exists
            // to remove. The caution belongs on names we cannot reason about,
            // not on this one.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.261"), "2.1.261")
            mkdirSync(join(paths.volumeDataDir, "versions", "2.1.261"), { recursive: true })
            writeFileSync(join(paths.volumeDataDir, "versions", "2.1.261", "junk"), "x")

            const result = run()

            expect(result.status).toBe(0)
            expect(lstatSync(join(paths.volumeDataDir, "versions", "2.1.261")).isFile()).toBe(true)
        })

        it("recovers on the first start and stays recovered on later ones", () => {
            // The measured regression this replaces: with a bad entry in the
            // volume, three consecutive starts all failed rc=1 and no run could
            // clear it. Repeating the probe is what a user does — `ccc` again —
            // so the recovery has to hold across runs, not just once.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.261"), "2.1.261")
            mkdirSync(join(paths.volumeDataDir, "versions", "2.1.261"), { recursive: true })

            const statuses = [run(), run(), run()].map(r => r.status)

            expect(statuses).toEqual([0, 0, 0])
            // The launcher points through the data-dir symlink, so what matters
            // is where it resolves: the version that is actually in the volume.
            expect(realpathSync(paths.bin)).toBe(join(paths.volumeDataDir, "versions", "2.1.261"))
        })

        it("replaces a dangling symlink in the volume instead of blocking on it", () => {
            // A link to nothing cannot be what another container is running,
            // and it is a name no later run could ever free on its own.
            writeFakeClaude(join(paths.dataDir, "statsig"), "2.1.5")
            mkdirSync(paths.volumeDataDir, { recursive: true })
            symlinkSync(join(root, "nonexistent"), join(paths.volumeDataDir, "statsig"))

            const result = run()

            expect(result.status).toBe(0)
            expect(lstatSync(join(paths.volumeDataDir, "statsig")).isFile()).toBe(true)
        })

        it("still refuses when the bad entry cannot be removed", () => {
            // Replacing is only correct when it actually happens. On a
            // read-only volume the removal fails, and the caller deletes the
            // original on success — so this has to stay a refusal.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.261"), "2.1.261")
            const versions = join(paths.volumeDataDir, "versions")
            mkdirSync(join(versions, "2.1.261"), { recursive: true })
            chmodSync(versions, 0o555)

            const result = run()

            chmodSync(versions, 0o755)
            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("versions/2.1.261")
            expect(existsSync(join(paths.dataDir, "versions", "2.1.261"))).toBe(true)
        })

        it("does not overwrite a version another container may be executing", () => {
            // Reported from a real ccc run: `cp: cannot create regular file
            // '.../.claude-data/./versions/2.1.261': Text file busy`. The volume
            // is shared by every project on the host, so a version already there
            // can be the binary a different container is running right now.
            // Overwriting it fails with ETXTBSY and takes ccc startup down for a
            // project that was working. Version files are named by their
            // content, so an existing one is left alone.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.261"), "2.1.261")
            const shared = join(paths.volumeDataDir, "versions", "2.1.261")
            writeFakeClaude(shared, "2.1.261")
            writeFileSync(shared, `#!/bin/sh\n# in use by another container\n[ "$1" = "--version" ] && echo "2.1.261 (Claude Code)"\nexit 0\n`)
            chmodSync(shared, 0o755)

            const result = run()

            expect(result.status).toBe(0)
            expect(result.stdout).toBe("RESTORED 2.1.261")
            // The shared copy is untouched — same bytes it had before.
            expect(readFileSync(shared, "utf8")).toContain("in use by another container")
        })

        it("adopts a data dir symlinked somewhere else instead of abandoning the install", () => {
            // Repointing the link on its own looks harmless and costs every
            // project on the host a fresh 215MB download, while the install it
            // walked away from sits untouched.
            const elsewhere = join(root, "elsewhere")
            writeFakeClaude(join(elsewhere, "versions", "2.1.5"), "2.1.5")
            mkdirSync(join(paths.dataDir, ".."), { recursive: true })
            symlinkSync(elsewhere, paths.dataDir)

            expect(run().stdout).toBe("RESTORED 2.1.5")
            expect(readlinkSync(paths.dataDir)).toBe(paths.volumeDataDir)
            expect(existsSync(join(paths.volumeDataDir, "versions", "2.1.5"))).toBe(true)
        })

        it("moves an existing real data directory into the volume instead of discarding it", () => {
            // A container that predates this layout has a real ~/.local/share/claude.
            // Losing it would force a re-download of an install that already works.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.5"), "2.1.5")

            const result = run()

            expect(result.stdout).toBe("RESTORED 2.1.5")
            expect(lstatSync(paths.dataDir).isSymbolicLink()).toBe(true)
            expect(existsSync(join(paths.volumeDataDir, "versions", "2.1.5"))).toBe(true)
        })
    })

    describe("launcher shape", () => {
        it.skipIf(!canBindMount)("refuses to replace a launcher path that is a mount point", () => {
            // A directory at the launcher path is pathological and gets removed
            // — unless the user mounted something there, in which case the
            // removal reaches through it.
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.261"), "2.1.261")
            mkdirSync(paths.bin, { recursive: true })
            const source = join(root, "mounted-bin")
            mkdirSync(source, { recursive: true })
            writeFileSync(join(source, "precious"), "the other side of the mount")

            const script = join(root, "probe.sh")
            writeFileSync(script, buildClaudeProbeScript(paths))
            let stderr = ""
            try {
                execFileSync("unshare", ["-Umr", "sh", "-c",
                    `mount --bind '${source}' '${paths.bin}' && sh '${script}'`],
                    { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } })
            } catch (error) {
                stderr = ((error as { stderr?: string }).stderr ?? "")
            }

            expect(readFileSync(join(source, "precious"), "utf8")).toBe("the other side of the mount")
            expect(stderr).toContain("refusing to replace")
            expect(stderr).toContain(paths.bin)
            expect(stderr).not.toContain("RESTORED")
        })

        it("does not report success when the launcher path could not be removed", () => {
            // rm -rf was unchecked, so a removal that failed left ln writing the
            // launcher INSIDE the surviving directory — where nothing runs it —
            // while the probe printed RESTORED and exited 0. No mount needed: a
            // read-only parent is enough.
            //
            // What is at stake is the report, not the contents: rm -rf empties
            // a directory it cannot unlink, so by this point they are already
            // gone. That is what the mount guard exists to prevent, earlier;
            // this one exists so a start that failed says so.
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.261"), "2.1.261")
            mkdirSync(paths.bin, { recursive: true })
            const parent = join(root, "bin")
            chmodSync(parent, 0o555)

            const result = run()

            chmodSync(parent, 0o755)
            expect(result.status).not.toBe(0)
            expect(result.stdout).not.toContain("RESTORED")
            // and no launcher hidden inside the directory that survived
            expect(existsSync(join(paths.bin, "2.1.261"))).toBe(false)
        })

        it("makes the launcher a symlink into versions/, which is what the native updater requires", () => {
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.5"), "2.1.5")

            const result = run()

            expect(result.stdout).toBe("RESTORED 2.1.5")
            expect(lstatSync(paths.bin).isSymbolicLink()).toBe(true)
            expect(readlinkSync(paths.bin)).toBe(join(paths.dataDir, "versions", "2.1.5"))
        })

        it("replaces a flattened regular-file launcher with a symlink", () => {
            // The exact state this task exists to fix. Before, a valid binary
            // sitting here short-circuited the probe as VALID and stayed a
            // regular file forever.
            writeFakeClaude(paths.bin, "2.1.241")

            const result = run()

            expect(result.stdout).toBe("RESTORED 2.1.241")
            expect(lstatSync(paths.bin).isSymbolicLink()).toBe(true)
            expect(readlinkSync(paths.bin)).toBe(join(paths.dataDir, "versions", "2.1.241"))
        })

        it("clears a directory squatting on the launcher path instead of wedging", () => {
            // ccc cannot produce this state, so the point is to pin the choice:
            // self-heal rather than fail every startup until a human intervenes.
            mkdirSync(join(paths.bin, "junk"), { recursive: true })
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.5"), "2.1.5")

            expect(run().stdout).toBe("RESTORED 2.1.5")
            expect(lstatSync(paths.bin).isSymbolicLink()).toBe(true)
        })

        it("reports VALID and changes nothing on a second run", () => {
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.5"), "2.1.5")

            expect(run().stdout).toBe("RESTORED 2.1.5")
            const linkAfterFirst = readlinkSync(paths.bin)

            expect(run().stdout).toBe("VALID")
            expect(readlinkSync(paths.bin)).toBe(linkAfterFirst)
        })

        it("selects the newest version by version order, not lexical order", () => {
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.9"), "2.1.9")
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.10"), "2.1.10")

            run()

            expect(readlinkSync(paths.bin)).toBe(join(paths.dataDir, "versions", "2.1.10"))
        })

        it("skips a mise shim sitting in versions/ even though it answers --version", () => {
            // mise reshim can drop a wrapper anywhere on PATH, and it reports a
            // perfectly valid claude version because it forwards to the real
            // binary. Linking the launcher at it would make ccc depend on mise
            // resolving node at every startup.
            writeMiseShim(join(paths.volumeDataDir, "versions", "2.1.300"))
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.5"), "2.1.5")

            run()

            expect(readlinkSync(paths.bin)).toBe(join(paths.dataDir, "versions", "2.1.5"))
        })

        it("finds a working version buried under many broken ones instead of reinstalling", () => {
            // An earlier version stopped after the five newest candidates. Ten
            // broken entries above a good one therefore reported INSTALL, and
            // every project on the host re-downloaded 215MB while the working
            // binary sat in the same directory.
            mkdirSync(join(paths.volumeDataDir, "versions"), { recursive: true })
            for (let minor = 20; minor < 30; minor++) {
                const broken = join(paths.volumeDataDir, "versions", `2.1.${minor}`)
                writeFileSync(broken, "#!/bin/sh\nexit 1\n")
                chmodSync(broken, 0o755)
            }
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.5"), "2.1.5")

            expect(run().stdout).toBe("RESTORED 2.1.5")
            expect(readlinkSync(paths.bin)).toBe(join(paths.dataDir, "versions", "2.1.5"))
        })

        it("gives each version check its own deadline so one wedged binary cannot stall startup", () => {
            // The probe's stdio is captured, so a binary that never returns is
            // 150 seconds of complete silence. A per-call timeout turns that
            // into one skipped candidate.
            mkdirSync(join(paths.volumeDataDir, "versions"), { recursive: true })
            const wedged = join(paths.volumeDataDir, "versions", "2.1.300")
            writeFileSync(wedged, "#!/bin/sh\nsleep 600\n")
            chmodSync(wedged, 0o755)
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.5"), "2.1.5")

            const started = Date.now()
            const result = run()
            const elapsed = Date.now() - started

            expect(result.stdout).toBe("RESTORED 2.1.5")
            expect(elapsed).toBeLessThan(30_000)
        }, 60_000)

        it("recovers past a truncated version that will never be replaced", () => {
            // Copies into the volume skip what already exists, so a version left
            // half-written by an interrupted install is never overwritten. That
            // is only safe because the scan does not stop at it: measured here,
            // the probe rejects it and links the working version below it. The
            // stranded file costs one --version spawn and nothing else.
            mkdirSync(join(paths.volumeDataDir, "versions"), { recursive: true })
            const truncated = join(paths.volumeDataDir, "versions", "2.1.300")
            writeFileSync(truncated, "\x7fELF truncated")
            chmodSync(truncated, 0o755)
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.261"), "2.1.261")

            expect(run().stdout).toBe("RESTORED 2.1.261")
            expect(existsSync(truncated)).toBe(true)
        })

        it("skips a corrupt newest version and falls back to a working one", () => {
            writeFileSync(join(root, "corrupt"), "not a binary\n")
            mkdirSync(join(paths.volumeDataDir, "versions"), { recursive: true })
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.5"), "2.1.5")
            writeFileSync(join(paths.volumeDataDir, "versions", "2.1.6"), "#!/bin/sh\nexit 1\n")
            chmodSync(join(paths.volumeDataDir, "versions", "2.1.6"), 0o755)

            run()

            expect(readlinkSync(paths.bin)).toBe(join(paths.dataDir, "versions", "2.1.5"))
        })
    })

    describe("migration from the pre-symlink single-file cache", () => {
        it("seeds versions/ from the legacy cache rather than reinstalling", () => {
            writeFakeClaude(paths.legacyCacheFile, "2.1.241")

            const result = run()

            expect(result.stdout).toBe("RESTORED 2.1.241")
            expect(existsSync(join(paths.volumeDataDir, "versions", "2.1.241"))).toBe(true)
            expect(readlinkSync(paths.bin)).toBe(join(paths.dataDir, "versions", "2.1.241"))
        })

        it("refuses to seed over a version name that already exists", () => {
            // mv -f onto a file succeeds even while another container is running
            // it — rename() swaps the directory entry, so that container gets a
            // donor copy on its next resolve. Refusing costs a re-download; the
            // installer writes a fresh version name and recovery still works.
            const occupied = join(paths.volumeDataDir, "versions", "2.1.241")
            mkdirSync(join(occupied, ".."), { recursive: true })
            writeFileSync(occupied, "#!/bin/sh\n# another container's copy\nexit 1\n")
            chmodSync(occupied, 0o755)
            writeFakeClaude(paths.legacyCacheFile, "2.1.241")

            expect(run().stdout).toBe("INSTALL")
            expect(readFileSync(occupied, "utf8")).toContain("another container's copy")
        })

        it("refuses to seed on top of a directory rather than half-publishing into it", () => {
            // If versions/<v> is ever a directory — an upstream layout change,
            // or a half-finished install — `mv -f` deposits the seed INSIDE it
            // and leaves the version name permanently unusable, which turns
            // into "Claude installation left no usable launcher" on every run.
            const occupied = join(paths.volumeDataDir, "versions", "2.1.241")
            mkdirSync(occupied, { recursive: true })
            writeFakeClaude(join(occupied, "claude"), "2.1.241")
            writeFakeClaude(paths.legacyCacheFile, "2.1.241")

            expect(run().stdout).toBe("INSTALL")
            expect(readdirSync(occupied)).toEqual(["claude"])
        })

        it("prefers an existing version over the legacy cache", () => {
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.261"), "2.1.261")
            writeFakeClaude(paths.legacyCacheFile, "2.1.241")

            run()

            expect(readlinkSync(paths.bin)).toBe(join(paths.dataDir, "versions", "2.1.261"))
        })
    })

    describe("fail-closed when the volume link cannot be established", () => {
        // These are the reason an in-container `claude update` can never be
        // silently discarded. If the data dir is not backed by the volume, the
        // probe must fail loudly so ccc aborts before a session starts — rather
        // than report a status and let the user update into a directory that
        // disappears with the container.

        it("fails instead of reporting a status when the existing data dir cannot be copied", () => {
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.5"), "2.1.5")
            const unreadable = join(paths.dataDir, "unreadable")
            writeFileSync(unreadable, "secret\n")
            chmodSync(unreadable, 0o000)

            const result = run()

            expect(result.status).not.toBe(0)
            expect(result.stdout).toBe("")
            // The original is still there — a failed copy must not have deleted it.
            expect(existsSync(join(paths.dataDir, "versions", "2.1.5"))).toBe(true)
        })

        it("reports a failed copy instead of publishing a half-adopted tree", () => {
            // What this pins: a copy that fails leaves no version name behind,
            // no staging file, and a non-zero exit — so the caller cannot delete
            // the original believing the adopt succeeded.
            //
            // What it does NOT pin, stated because the mutation survives it:
            // that staging-then-linking prevents a TRUNCATED publish. An
            // unreadable source fails at open, so nothing partial is written
            // either way, and reproducing a real mid-copy death is not something
            // to put in a suite. That property was measured by hand on a 1.5GB
            // copy — a staging file is observable while it runs, and the version
            // name is already at full size the instant it first exists.
            const unreadable = join(paths.dataDir, "versions", "2.1.9")
            mkdirSync(join(unreadable, ".."), { recursive: true })
            writeFileSync(unreadable, "would be a 215MB binary\n")
            chmodSync(unreadable, 0o000)

            const result = run()

            expect(result.status).not.toBe(0)
            expect(existsSync(join(paths.volumeDataDir, "versions", "2.1.9"))).toBe(false)
            expect(readdirSync(paths.volumeDataDir).filter(n => n.startsWith(".seed."))).toEqual([])
        })

        it("refuses up front when it cannot create its failure marker", () => {
            // Review flagged this as the one line worth pinning: without the
            // guard on the marker's own creation, adopt cannot record any
            // failure and returns success — and the caller deletes the original
            // on success. Driven by making the temp directory unusable, which is
            // where the marker is created.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.5"), "2.1.5")

            const result = runWithEnv({ PATH: "/usr/bin:/bin", TMPDIR: join(root, "no-such-dir") })

            expect(result.status).not.toBe(0)
            expect(result.stdout).toBe("")
            expect(existsSync(join(paths.dataDir, "versions", "2.1.5"))).toBe(true)
        })

        it("keeps its failure marker out of the volume every project shares", () => {
            // The marker is intra-container signalling. Putting it in the shared
            // volume means the one failure it exists to report — the volume
            // being unwritable — is the one it cannot record, and a failed run
            // leaves an invisible dotfile in a volume nobody thinks to look in.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.5"), "2.1.5")

            expect(run().stdout).toBe("RESTORED 2.1.5")

            const litter = readdirSync(paths.volumeDataDir).filter(n => n.startsWith(".adopt-failed"))
            expect(litter).toEqual([])
            expect(buildClaudeProbeScript(paths)).not.toContain('"$VOL/.adopt-failed')
        })

        it("reports a link failure instead of letting the caller delete an unadopted original", () => {
            // adopt swallowed every ln failure, not only "another container won
            // this name". A cross-device or ENOSPC failure left the file NOT in
            // the volume while adopt still returned 0 — and the caller deletes
            // the original on success. Driven here by making the destination
            // directory unwritable after the tree walk has something to place.
            writeFakeClaude(join(paths.dataDir, "versions", "2.1.5"), "2.1.5")
            mkdirSync(paths.volumeDataDir, { recursive: true })
            mkdirSync(join(paths.volumeDataDir, "versions"), { recursive: true })
            chmodSync(join(paths.volumeDataDir, "versions"), 0o500)

            const result = run()

            try {
                expect(result.status).not.toBe(0)
                expect(result.stdout).toBe("")
                // the original must still be there for a later run to adopt
                expect(existsSync(join(paths.dataDir, "versions", "2.1.5"))).toBe(true)
            } finally {
                chmodSync(join(paths.volumeDataDir, "versions"), 0o700)
            }
        })

        it("fails when a foreign data-dir symlink cannot be adopted, instead of reporting success", () => {
            // The sibling directory case was covered; this one was not, and it
            // failed OPEN. A failed copy leaves $DATA a symlink pointing
            // elsewhere, and a guard that checks only "is it a symlink" passes —
            // so the probe reported RESTORED, linked the launcher into a
            // container-local directory, and announced it was reusing the shared
            // volume. That is the original bug with a success message on top.
            const elsewhere = join(root, "elsewhere")
            writeFakeClaude(join(elsewhere, "versions", "2.1.5"), "2.1.5")
            const unreadable = join(elsewhere, "unreadable")
            writeFileSync(unreadable, "secret\n")
            chmodSync(unreadable, 0o000)
            mkdirSync(join(paths.dataDir, ".."), { recursive: true })
            symlinkSync(elsewhere, paths.dataDir)

            const result = run()

            expect(result.status).not.toBe(0)
            expect(result.stdout).toBe("")
            expect(existsSync(paths.bin)).toBe(false)
        })

        it("fails when the volume directory cannot be created", () => {
            // A regular file where the volume dir belongs: mkdir -p cannot win.
            mkdirSync(join(paths.volumeDataDir, ".."), { recursive: true })
            writeFileSync(paths.volumeDataDir, "not a directory\n")

            const result = run()

            expect(result.status).not.toBe(0)
            expect(result.stdout).toBe("")
        })
    })

    describe("nothing usable", () => {
        it("asks for an install when the volume is empty", () => {
            expect(run().stdout).toBe("INSTALL")
            expect(existsSync(paths.bin)).toBe(false)
        })

        it("finds a version whose name holds a space or a glob character", () => {
            // The selection loop read its candidates through $(ls), so a name
            // holding a space was split into two that do not exist and one
            // holding * was expanded against the working directory. Neither can
            // be an installer target, so this never wedged anything — but the
            // two loops over the same directory disagreed about what they saw.
            const volVersions = join(paths.volumeDataDir, "versions")
            mkdirSync(volVersions, { recursive: true })
            writeFakeClaude(join(volVersions, "2.1.261 rc1"), "2.1.261 rc1")

            const result = run()

            expect(result.stdout).toBe("RESTORED 2.1.261 rc1")
            expect(realpathSync(paths.bin)).toBe(join(volVersions, "2.1.261 rc1"))
        })

        it("does not select a version that is a symlink", () => {
            // -f follows links, so a symlink under versions/ used to be chosen
            // and reported as a successful start — on precisely the layout the
            // doctor calls NOT updatable, which is the bug this whole change
            // removes. ccc never publishes one; a shared volume can still hold
            // one that a person put there.
            const elsewhere = join(root, "elsewhere")
            writeFakeClaude(join(elsewhere, "real"), "9.9.9")
            mkdirSync(join(paths.volumeDataDir, "versions"), { recursive: true })
            symlinkSync(join(elsewhere, "real"), join(paths.volumeDataDir, "versions", "9.9.9"))
            writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.261"), "2.1.261")

            const result = run()

            expect(result.stdout).toBe("RESTORED 2.1.261")
            expect(realpathSync(paths.bin)).toBe(join(paths.volumeDataDir, "versions", "2.1.261"))
            // and the name is freed, not merely passed over, because it is a
            // name the installer needs
            expect(existsSync(join(paths.volumeDataDir, "versions", "9.9.9"))).toBe(false)
            expect(result.stderr).toContain("removed 9.9.9")
        })

        it("still refuses to run a symlinked version it could not remove", () => {
            // Freeing the name is the repair; refusing to run the link is the
            // guarantee. On a volume ccc cannot write to, the repair is not
            // available and the guarantee has to hold on its own — running it
            // would put the user back on a launcher claude update cannot
            // replace, which is the bug this work exists to remove.
            const elsewhere = join(root, "elsewhere")
            writeFakeClaude(join(elsewhere, "real"), "9.9.9")
            const volVersions = join(paths.volumeDataDir, "versions")
            mkdirSync(volVersions, { recursive: true })
            symlinkSync(join(elsewhere, "real"), join(volVersions, "9.9.9"))
            chmodSync(volVersions, 0o555)

            const result = run()

            chmodSync(volVersions, 0o755)
            expect(result.stdout).toBe("INSTALL")
            expect(result.stderr).toContain("cannot remove 9.9.9")
        })

        it("frees a version name held by a symlink instead of wedging on it", () => {
            // Runtime QA measured the wedge this replaces: a hand-made link
            // named for the version the installer produces. The installer
            // declines a name that exists, the probe declined the link, and the
            // start failed identically every time — a full download each round,
            // with nothing changed. Skipping an entry is not enough when the
            // entry is also holding the name the fix needs.
            const elsewhere = join(root, "elsewhere")
            writeFakeClaude(join(elsewhere, "real"), "2.1.261")
            mkdirSync(join(paths.volumeDataDir, "versions"), { recursive: true })
            symlinkSync(join(elsewhere, "real"), join(paths.volumeDataDir, "versions", "2.1.261"))

            const result = run()

            expect(result.status).toBe(0)
            expect(result.stdout).toBe("INSTALL")
            // INSTALL is only useful if the installer can now write that name
            expect(existsSync(join(paths.volumeDataDir, "versions", "2.1.261"))).toBe(false)
        })

        it("does not adopt a mise shim as a claude binary", () => {
            writeMiseShim(paths.bin)

            expect(run().stdout).toBe("INSTALL")
        })

        it("does not copy a rejected donor into the shared volume", () => {
            // Rejecting the donor at the launcher step is not enough. Seeding it
            // first would put ~215MB of the wrong binary into a volume every ccc
            // project on the host shares, once per container start. The guard has
            // to be in the seeding step, and only versions/ staying empty can
            // tell the two apart.
            writeMiseShim(paths.bin)

            run()

            expect(existsSync(join(paths.volumeDataDir, "versions"))).toBe(false)
        })

        it("does not copy a non-Claude binary into the shared volume either", () => {
            // `bun 1.1.0` yields a plausible-looking version string, so a seeding
            // step that trusts the version regex alone would cache bun as claude.
            writeFileSync(paths.bin, `#!/bin/sh\necho "bun 1.1.0"\n`)
            chmodSync(paths.bin, 0o755)

            run()

            expect(existsSync(join(paths.volumeDataDir, "versions"))).toBe(false)
        })

        it("accepts a version line that names Claude after the number", () => {
            // The word-boundary alternative of the version regex was dead: `\b`
            // inside a template literal is a backspace byte, not a boundary, so
            // only lines shaped like "2.1.5 (Claude Code)" ever matched. Every
            // fake here printed exactly that shape, which is why nothing noticed.
            const versioned = join(paths.volumeDataDir, "versions", "2.1.5")
            mkdirSync(join(versioned, ".."), { recursive: true })
            writeFileSync(versioned, `#!/bin/sh\n[ "$1" = "--version" ] && echo "2.1.5-rc1 Claude Code"\nexit 0\n`)
            chmodSync(versioned, 0o755)

            expect(run().stdout).toBe("RESTORED 2.1.5")
        })

        it("does not adopt a binary whose --version is not Claude-shaped", () => {
            writeFileSync(paths.bin, `#!/bin/sh\necho "bun 1.1.0"\n`)
            chmodSync(paths.bin, 0o755)

            expect(run().stdout).toBe("INSTALL")
        })

        it("does not read a Bun crash dump as a version, even though it names claude", () => {
            // A crashing bun printed its argv, which contains the claude path.
            // A looser match would have adopted the crash output as proof of a
            // working binary and cached it. `is_claude` reads only the first
            // line and anchors the version at its start; both matter here.
            writeFileSync(
                paths.bin,
                [
                    "#!/bin/sh",
                    "echo '============================================================'",
                    `echo 'Args: "/home/ccc/.local/bin/claude" "--dangerously-skip-permissions"'`,
                    "echo 'Bun v1.3.14 (521eedd6) Linux x64'",
                    "",
                ].join("\n"),
            )
            chmodSync(paths.bin, 0o755)

            expect(run().stdout).toBe("INSTALL")
        })
    })
})

describe("what ccc doctor says about the launcher", () => {
    // The version alone was all doctor reported, and the version alone is
    // exactly what looks fine in the broken state: 2.1.241 is a real version,
    // printed by a real binary, at the right path. Only the shape distinguishes
    // "up to date" from "pinned forever".
    function report(binPath: string): { status: number, stdout: string } {
        try {
            const stdout = execFileSync("sh", ["-c", buildClaudeLauncherReportCommand(binPath, paths.dataDir)],
                { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } })
            return { status: 0, stdout: stdout.trim() }
        } catch (error) {
            const e = error as { status?: number, stdout?: string }
            return { status: e.status ?? -1, stdout: (e.stdout ?? "").trim() }
        }
    }

    it("says a symlinked launcher is updatable, and where it points", () => {
        writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.5"), "2.1.5")
        run()

        const out = report(paths.bin).stdout

        expect(out).toContain("2.1.5 (Claude Code)")
        expect(out).toContain("updatable")
        // The reported target is fully resolved, so it names the volume the
        // version actually lives in rather than the symlink hop through $DATA.
        expect(out).toContain(join(paths.volumeDataDir, "versions", "2.1.5"))
    })

    it("does not call a symlink pointing outside versions/ updatable", () => {
        // Being a symlink is not the requirement — the updater manages the
        // launcher only when it resolves INTO versions/. Reporting any symlink
        // as updatable would hide the state this check exists to surface.
        const stray = join(root, "stray-claude")
        writeFakeClaude(stray, "2.1.5")
        mkdirSync(join(paths.bin, ".."), { recursive: true })
        symlinkSync(stray, paths.bin)

        const out = report(paths.bin).stdout

        expect(out).toContain("NOT updatable")
    })

    it("signals the not-updatable state by exit code, not only in prose", () => {
        // doctor rendered this as a green check with "All checks passed",
        // because it keyed off "the command succeeded" — and the command
        // succeeded while reporting the exact state it exists to surface. An
        // exit code is what a caller can act on.
        writeFakeClaude(paths.bin, "2.1.241")
        expect(report(paths.bin).status).toBe(2)

        rmSync(paths.bin)
        writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.5"), "2.1.5")
        run()
        expect(report(paths.bin).status).toBe(0)
    })

    it("says a plain-file launcher is NOT updatable, which is the whole bug", () => {
        writeFakeClaude(paths.bin, "2.1.241")

        const out = report(paths.bin).stdout

        expect(out).toContain("2.1.241 (Claude Code)")
        expect(out).toContain("NOT updatable")
    })

    it("names the same directory whether or not the launcher is updatable", () => {
        // One branch printed the resolved path and the other the literal, so a
        // user comparing the two outputs was told about two directories for one
        // place. Nothing pinned that: reverting the failure branch to the
        // literal left the whole file green, in a file whose own history is
        // assertions that matched text instead of behavior.
        writeFakeClaude(join(paths.volumeDataDir, "versions", "2.1.261"), "2.1.261")
        run()
        const updatable = report(paths.bin).stdout

        rmSync(paths.bin)
        writeFakeClaude(paths.bin, "2.1.241")
        const notUpdatable = report(paths.bin).stdout

        const resolved = join(paths.volumeDataDir, "versions")
        expect(updatable).toContain(resolved)
        expect(notUpdatable).toContain(resolved)
        expect(notUpdatable).not.toContain(`${paths.dataDir}/versions`)
    })

    it("names a real directory when there is no versions directory to resolve", () => {
        // The sentinel exists so an absent versions dir matches nothing. It
        // must never be what the user is told to look at.
        writeFakeClaude(paths.bin, "2.1.241")

        const out = report(paths.bin).stdout

        expect(out).toContain("NOT updatable")
        expect(out).not.toContain("__no_versions_dir__")
    })

    it("does not report a launcher in a different directory as updatable", () => {
        // The check must answer "does this launcher resolve INTO versions/".
        // `${target#$expected/}` treats the expected path as a glob, so a data
        // dir literally named `a*b` matches a sibling `aXXXb` and a launcher
        // pointing at that sibling is announced as updatable — the check
        // reporting success about a directory it has never seen.
        const globbyData = join(root, "a*b")
        const sibling = join(root, "aXXXb")
        mkdirSync(join(globbyData, "versions"), { recursive: true })
        writeFakeClaude(join(sibling, "versions", "2.1.5"), "2.1.5")
        const launcher = join(root, "bin", "claude-elsewhere")
        symlinkSync(join(sibling, "versions", "2.1.5"), launcher)

        // exits 2 for the not-updatable state, so read it the way doctor does
        let out = ""
        try {
            out = execFileSync("sh", ["-c", buildClaudeLauncherReportCommand(launcher, globbyData)],
                { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } })
        } catch (error) {
            const e = error as { status?: number, stdout?: string }
            expect(e.status).toBe(2)
            out = e.stdout ?? ""
        }

        expect(out).toContain("NOT updatable")
    })

    it("fails rather than reporting a version when there is no launcher", () => {
        expect(report(paths.bin).status).not.toBe(0)
    })
})
