import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs"
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
function run(): { status: number, stdout: string } {
    const options = { encoding: "utf-8" as const, env: { PATH: "/usr/bin:/bin" } }
    try {
        const stdout = execFileSync("sh", ["-c", buildClaudeProbeScript(paths)], options)
        return { status: 0, stdout: stdout.trim() }
    } catch (error) {
        const e = error as { status?: number, stdout?: string }
        return { status: e.status ?? -1, stdout: (e.stdout ?? "").trim() }
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
            const stdout = execFileSync("sh", ["-c", buildClaudeLauncherReportCommand(binPath)],
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
        expect(out).toContain(join(paths.dataDir, "versions", "2.1.5"))
    })

    it("says a plain-file launcher is NOT updatable, which is the whole bug", () => {
        writeFakeClaude(paths.bin, "2.1.241")

        const out = report(paths.bin).stdout

        expect(out).toContain("2.1.241 (Claude Code)")
        expect(out).toContain("NOT updatable")
    })

    it("fails rather than reporting a version when there is no launcher", () => {
        expect(report(paths.bin).status).not.toBe(0)
    })
})
