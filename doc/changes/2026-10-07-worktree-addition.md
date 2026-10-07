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

## Known ceiling

Outer dispatch, workspace copying, nested repair and full removal remain native
workflows for subsequent migration. This operation does not finish M11 or the
overall architecture transition. Portable checks do not certify native Mac
Colima or Windows VM execution; those acceptance lanes remain separate.
