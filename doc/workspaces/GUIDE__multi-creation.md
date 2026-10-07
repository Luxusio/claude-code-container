# Multi-repo workspace creation boundary

The multi creation application owns strict entry classification, atomic creation
sequence, per-repository addition, copy bookkeeping and both compensation flows.
It composes the existing addition application. Required semantic ports supply
scanning, paths, exclusive mkdir, native identities, copying and fenced cleanup;
the application never inspects or fabricates opaque native proof.
Registration and copied identity types accept object or symbol references, not
numeric/boolean tokens. This matches the retained native truthiness checks for
missing proof and prevents valid-looking zero values from skipping compensation.

Parent mkdir precedes exclusive mkdir, and only the exclusive call translates
EEXIST. Workspace identity capture is outside repository rollback. Each added
repository is recorded with its prepared token before registration is required.
Each copied entry is recorded before its identity is captured. Failed proof
capture therefore retains the candidate without inventing deletion authority.

Repository-phase rollback runs forward with existence and worktree checks.
Copy-phase rollback runs registered entries backward, then receipt-backed copies
backward, without adding those forward prechecks. Failed removal stops that
entry's branch cleanup. Root identity and native quarantine rules remain unchanged.

Catch placement is part of the contract. Repository destination calculation is
inside its phase try; copy destination calculation is outside the copy try.
Forward rollback observations and final partial-copy existence checks keep their
original uncaught behavior. A nonempty root reports an error during repository
rollback but is silently preserved after clean copy rollback. Preserve exact
diagnostic order, property access, joins, original cause and thrown identity.

Core trace and fault tests establish these boundaries. Actual private-Git facade
tests and existing race/partial-copy/tracking regressions establish native safety.
Both shipping forms must execute compiled forward/reverse policy, multiple real
repositories and plain-file copying, plus legacy mutable entry/result declarations.

Outer dispatch, repair/removal internals and remaining M11–M14 work remain separate.
Portable verification does not certify native Mac/Windows VM execution.
