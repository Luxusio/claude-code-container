# Multi-repo removal application cutover

Multi-repo workspace removal moves its entire ordered removal and final workspace
cleanup sequence into a synchronous application with fifteen required native
effects. The facade retains outer validation and dispatch, while native identity,
registration, ownership and quarantine helpers keep their original authority.
The public RemoveResult shape now has domain ownership and retains mutable arrays
and the original root type export.

Missing entries keep existsSync semantics. Repository prechecks remain uncaught;
registration capture and removal retain their catch. Copied-entry successor
checks retain their catch and refusals. Final identity assertion still precedes
an existing-error return, and force cleanup still refuses newly observed Git
content. Entry force reads use strict equality; final force uses truthiness.
Opaque proofs, option references, unknown thrown values, relay failures and
nullish message-property behavior remain unchanged. Removal deletes no branch ref.

Verification is assigned to the coordinator after implementation and test writers
stop: focused architecture and full worktree regressions, five type configurations,
scoped lint, both actual shipping forms and candidate CLI removal proofs. This
note records the implementation boundary; acceptance evidence is recorded by the
coordinator after fresh independent review and QA. Unified removal, repair,
remaining migration and native Mac/Windows acceptance remain separate.
