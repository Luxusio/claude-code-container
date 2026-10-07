# Reuse registered multi-repo workspaces

A plain source folder containing repositories must reopen its existing CCC
workspace through supported branch syntax without running Git root inspection
against that plain parent. Discover child repositories with strict one-level
directory inventory and require their actual Git registrations. Reuse preserves
checkout files, branch HEADs and registrations without recreating worktrees.

Git-root sources retain tracked-submodule inventory and exact root registration
checks. Existing malformed, symlink or unreadable Git metadata is not a plain
parent fallback. Metadata, inventory and registry failures remain failures.

Discovery does not authorize ownership. Existing reuse ownership checks must
refuse foreign replacement repositories and damaged or partial registrations,
preserving surviving/foreign content. Source names containing workspace separators
retain candidate iteration and canonical path deduplication. Symlink children and
ordinary files do not become owned repositories.

Verification covers actual private-Git multi creation then compiled CLI reuse
with unchanged file/HEAD/registration snapshots and no repeated add, named partial
registration failures, foreign preservation, unified nested sources and delegated
inspection faults. No native container/provider invocation is needed for this path.
