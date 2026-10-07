# Worktree addition application cutover

Unified and multi-repo workspace creation now invoke one application for branch
action selection, prepared addition and failed-add compensation. Four explicit
native ports retain the existing Git commands and exact preparation/registration
receipts. Public creation remains synchronous with the same result and errors.

Registration validation stays outside that operation: unified validates before
nested repair; multi records the rollback candidate and OID first. Actual Git
fault fixtures verify those distinct traces without replacing native authority.
Deterministic policy tests and compiled package/install consumers cover receipt
identity, call order, diagnostic precedence and generic port declarations.

Fresh independent QA at `51e85dfa` passed 79 files and 2,955 tests, with nine
skipped. The existing real-Git worktree suite passed 339 tests; five type
configurations, scoped lint, both shipping payloads and isolated CLI/private-Git
scenarios passed. Source and compiled bytes remained unchanged during that QA.

A first QA probe mistakenly invoked unsupported `worktree --help` without the
isolated environment, reached container preparation, and failed before container
creation. A host UID/GID identity cache image was created at the same time.
Read-only inspection found no container using it or leftover CLI child. Its labels
identify the shared runtime identity cache rather than this task, so it was retained
without deleting a potentially shared resource. Subsequent CLI probes used the
documented syntax, private HOME/Git fixtures and a strict fake runtime exclusively.

## Known ceiling

Outer dispatch, workspace copying, nested repair and full removal remain native
workflows for subsequent migration. This operation does not finish M11 or the
overall architecture transition. Portable checks do not certify native Mac
Colima or Windows VM execution; those acceptance lanes remain separate.
