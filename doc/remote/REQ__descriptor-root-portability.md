# Receiving-host descriptor root portability

Remote lifecycle and global bind-authority operations must work on the supported Linux and macOS receiving hosts without treating `/dev/fd/<directory>/child` as a portable directory namespace. Descriptor-bound reads require the standard native `tail` utility alongside the existing tools. Missing required tools produce the existing prerequisite refusal (exit 75). This correction introduces no receiving-host interpreter or package dependency.

Operations remain anchored to the directory generation opened and admitted by the caller. Canonical or lexical path spelling alone does not authorize a later write, claim, release or cleanup. A renamed or replaced root, symlink, invalid type or mode, changed inode, foreign claim or unavailable observation must retain the existing nonzero refusal and preserve successors and unrelated state.

If a pinned working directory is used, verify its identity against the held directory before admitting operations. Nested lifecycle and bind-authority work must retain each root independently, preserve exact container IDs and public output, and keep signal/exit cleanup scoped to owned claims. Repeated descriptor-bound reads must read the complete bounded record from its beginning rather than depend on platform-specific descriptor reopening offsets.

Cancellation must work both for a signal to the owning shell PID and for a process-group signal. Every intermediate scope must retain ownership until its protected native foreground work has stopped; it must not release a claim merely because a child shell exited. No later body statements may execute after cancellation.

An interruptible supervisor may signal only its exact operation-owned worker and descendants admitted through captured native ancestry, process birth and command identity. Revalidate that proof immediately before a signal. A changed or unavailable identity authorizes neither a guessed signal nor successful claim release. Do not substitute unverified process-group membership for ownership. POSIX asynchronous jobs may inherit ignored SIGINT; cancellation may use bounded TERM shutdown of the proved owned work while preserving the caller's HUP/INT/TERM exit status. Root or descendant replacement, delayed signal handling and cancellation before worker readiness require focused regression evidence.

If a previously admitted descendant is reparented during cancellation, its unchanged birth and command permit waiting for its actual completion, without signaling it under the former ancestry. A parent already proved absent is distinct from an unavailable or changed process identity.

Verify the existing native lifecycle, session, bind-authority and cache-identity fixtures, including contention, replacement, rename, malformed records and interrupted cleanup. Portable Linux results establish only those exercised branches; macOS descriptor and native-tool acceptance requires focused host results.
