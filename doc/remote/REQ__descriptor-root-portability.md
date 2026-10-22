# Receiving-host descriptor root portability

Remote lifecycle and global bind-authority operations must work on the supported Linux and macOS receiving hosts without treating `/dev/fd/<directory>/child` as a portable directory namespace. Descriptor-bound reads require the standard native `tail` utility alongside the existing tools. Missing required tools produce the existing prerequisite refusal (exit 75). This correction introduces no receiving-host interpreter or package dependency.

Operations remain anchored to the directory generation opened and admitted by the caller. Canonical or lexical path spelling alone does not authorize a later write, claim, release or cleanup. A renamed or replaced root, symlink, invalid type or mode, changed inode, foreign claim or unavailable observation must retain the existing nonzero refusal and preserve successors and unrelated state.

If a pinned working directory is used, verify its identity against the held directory before admitting operations. Nested lifecycle and bind-authority work must retain each root independently, preserve exact container IDs and public output, and keep signal/exit cleanup scoped to owned claims. Repeated descriptor-bound reads must read the complete bounded record from its beginning rather than depend on platform-specific descriptor reopening offsets.

Verify the existing native lifecycle, session, bind-authority and cache-identity fixtures, including contention, replacement, rename, malformed records and interrupted cleanup. Portable Linux results establish only those exercised branches; macOS descriptor and native-tool acceptance requires focused host results.
