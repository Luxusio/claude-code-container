# Device file listing

`list_files` lists one directory on the device identified by `deviceId`. Callers
provide `path`, without a backend selector. Results contain `entries` with each
entry's `name`, `type` (`file`, `directory`, `symlink`, or `other`) and optional
file `size` in bytes. Empty directories return an empty array. Hidden entries are
included. Listing never recursively traverses entries or reads file contents.

The default entry limit is 100; callers can request 1–500. A conservative output
byte limit also applies before transport. `truncated:true` means either limit was
reached, so a partial listing must never be mistaken for a complete directory.
Missing directories, permissions, failed commands and malformed responses remain
errors. Paths are command data, including whitespace, quotes and Unicode.

Android, Linux/QEMU, macOS, Windows Sandbox and Hyper-V reuse their existing
owned-device command transports. Required incarnation and physical lease checks
remain. Listing does not start devices, provision software, or install anything.
An iOS Simulator call requires `appId`; `path` is relative to that app container
and must not escape it through traversal or symlinks. Physical iOS/iPadOS currently has no
Device Lab listing adapter and reports that implementation limitation explicitly.
This does not mean the platform forbids all file access: apps enabling File
Sharing can expose their Documents files through supported host transports. A display ID is not a file
storage target.

Immediate POSIX glob enumeration can expand a large directory before the bounded
output loop. Existing command deadlines remain; entry/output limits do not promise
constant-time traversal. Real Windows/macOS/iOS behavior requires native host
validation in addition to command and adapter fixture tests.

Generated macOS listing scripts must select `/bin/sh` explicitly rather than
depend on the SSH user's login shell options. Quote the complete POSIX script
as one command argument using the existing quoting rule; caller paths remain
data through both quoting layers. Apply the 4096-character command budget to
the final wrapped command. This does not change general `device_exec` shell
semantics or the other backend commands, result framing, byte/entry limits,
error handling or ownership checks.

This is derived from a reproduced unmatched-glob failure under a strict outer
shell. The [zsh option contract](https://zsh.sourceforge.io/Doc/Release/Options.html#Expansion-and-Globbing)
also documents that `NOMATCH` reports unmatched filename patterns as errors.
Portable strict-shell checks establish command compatibility; the saved Mac
exit code alone does not identify its guest shell or stderr, and actual Mac
qualification remains separate.

Verification covers empty/hidden directories, filename quoting and newlines,
symlinks, missing paths, entry/byte limits, malformed transport results, ownership,
incarnation propagation, app-container containment and source/bundled MCP discovery.
