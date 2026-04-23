---
type: OBS
status: active
created: 2026-04-11
updated: 2026-04-11
tags: [tauri, windows, icon, rust, install]
evidence: |
  TASK__tauri-windows-icon-ico — 47/47 tests pass, npm run build exit 0, CRITIC__runtime.md verdict PASS;
  icon.ico is 122 bytes, idempotent SHA256 0a2b470809daf6179bf044ac7cedc281b653f3dcbf665660fe006e55f477c9b9;
  AC-007 PENDING_USER (Windows manual verification)
---

# tauri-build — icons/icon.ico required for Windows Resource generation

## The bug

`tauri-build` (the cargo build-dependency invoked as `tauri_build::build()` in
`ui/src-tauri/build.rs`) unconditionally generates a `.rc` Windows Resource file
when `CARGO_CFG_TARGET_OS=windows`. That resource file embeds the application
icon. If no valid `.ico` file is found at the expected path, the build fails with:

```
`icons/icon.ico` not found; required for generating a Windows Resource file during tauri-build
```

## Why Linux/macOS builds don't surface it

`tauri-build`'s `.rc` generation is gated on the Windows target triple. Linux and
macOS native compiles never reach the icon check, so CI or harness containers
running on non-Windows hosts give a false green signal. The error is Windows-only
and surfaces only when `cargo build` (directly or via `tauri build`) is run with a
`windows` target.

## Resolution order tauri-build uses

`tauri-build` reads the `bundle.icon` array from `tauri.conf.json` and uses the
first `.ico` entry it finds. If no `.ico` entry is listed in `bundle.icon`, it
falls back to the default path `icons/icon.ico` relative to the `src-tauri/`
directory. Either path must resolve to a valid ICO file on disk.

## ICO format notes

Modern (Vista+) ICO format allows a PNG-compressed image directly inside the ICO
container. This is sometimes called a "PNG-compressed ICO entry." Structure:

```
offset  size  field           value
0       2     Reserved        0x0000
2       2     Type            0x0001 (1 = ICO)
4       2     Count           0x0001 (1 image entry)
--- ICONDIRENTRY (16 bytes at offset 6) ---
6       1     Width           0x20 (32) — or 0x00 for "natural size"
7       1     Height          0x20 (32)
8       1     ColorCount      0x00 (0 for 32-bit)
9       1     Reserved        0x00
10      2     Planes          0x0001
12      2     BitCount        0x0020 (32)
14      4     BytesInRes      <len(png)>
18      4     ImageOffset     0x00000016 (22 = 6+16)
22      ...   PNG bytes       raw PNG data
```

The `ico` crate used internally by `tauri-build` accepts both classic BMP entries
and PNG-compressed entries. A single-entry PNG-compressed ICO is the minimal valid
file that satisfies the build requirement.

## Project-specific implementation

### Generator script

`scripts/generate-tauri-ico.mjs` (lines 1-34). Pure Node.js ESM using only stdlib
(`node:fs`, `node:url`, `node:path`, `Buffer`). No npm dependencies.

Algorithm:
1. Reads `ui/src-tauri/icons/icon.png`.
2. Validates the PNG magic bytes (`89504e470d0a1a0a`). Throws on mismatch.
3. Constructs a 6-byte ICONDIR header (reserved=0, type=1, count=1).
4. Constructs a 16-byte ICONDIRENTRY (width=32, height=32, colorcount=0,
   reserved=0, planes=1, bitcount=32, bytesize=len(png), offset=22).
5. Concatenates header + entry + raw PNG bytes and writes `ui/src-tauri/icons/icon.ico`.
6. Prints the output path and size. Idempotent: identical input produces identical
   output byte-for-byte.

### Config wiring

`ui/src-tauri/tauri.conf.json` `bundle.icon` field lists both `icons/icon.png`
and `icons/icon.ico` (lines 31-34). Belt-and-suspenders: `tauri-build` would find
`icon.ico` via the default fallback path regardless, but declaring it explicitly in
`bundle.icon` also covers future bundling paths that walk the icon list directly.

### Integrity test

`src/__tests__/tauri-ico-file.test.ts` (lines 1-36). Reads the committed `.ico`
and asserts byte-level structure: ICONDIR fields, ICONDIRENTRY bitcount=32 and
offset=22, PNG magic at offset 22, and `offset + bytesize == file length`. Runs as
part of the vitest suite. Functions as a corruption canary — if the binary file is
ever mangled by line-ending normalization (e.g. a misconfigured `.gitattributes`
treating `.ico` as text), the PNG magic assertion catches it immediately.

### Current icon

32x32 placeholder PNG (100 bytes) wrapped into a 122-byte ICO. The ICO is committed
to the repository. Real UX design and multi-size icon set (16, 32, 48, 256) are
follow-up work outside this task's scope.

## When to regenerate

Run `node scripts/generate-tauri-ico.mjs` whenever `ui/src-tauri/icons/icon.png`
is updated. The generator is idempotent and produces byte-identical output for the
same input. No other steps are required; `tauri-build` picks up the updated file
automatically.

## Why we didn't add Pillow/ImageMagick as a build dep

Pure Node.js stdlib keeps the installer surface minimal. For a single-entry
PNG-compressed ICO, the format is trivially constructible from raw `Buffer`
operations — no image-processing library is needed. Adding a native image dep
(sharp, Pillow, ImageMagick) would complicate cross-platform install for no gain.

## Prompted by

Task `TASK__tauri-windows-icon-ico` (2026-04-11). Predecessor chain (all closed):
`TASK__tauri-cli-win32-optional-deps`, `TASK__tauri-cli-optional-deps-fallback`,
`TASK__npm-optional-deps-env-override`. The Windows bring-up surfaces bugs one
layer at a time — this is the next layer after the npm/cli#4828 chain.

## Related notes

- `doc/common/OBS__install__windows-rust-exe-suffix.md` — sibling Windows install
  bug: Rust `.exe` suffix handling and Tauri `externalBin` extensionless convention.
- `doc/common/OBS__install__npm-optional-deps-4828.md` — sibling Windows install
  bug: npm skips platform-specific optional native bindings when lockfile is
  cross-platform or optional deps are globally suppressed.
