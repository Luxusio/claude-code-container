# Workspace branch validation

This is a narrow M11 candidate in the [architecture migration](../common/GUIDE__architecture-migration.md).
It extracts existing branch rejection policy; full workspace orchestration and
the broader architecture migration still require separate implementation and
acceptance.

## Pure application and native composition

`src/application/workspace-branch-validation.ts` exports
`createWorkspaceBranchValidation(ports)`, which returns a callable
`validate(branch): string`. Its only import is the type contract from
`src/ports/workspace-branch-validation.ts`. `WorkspaceBranchValidationPorts`
requires the readonly callable `utf8ByteLength(value: string): number`.

Construction checks `typeof ports?.utf8ByteLength` and throws
`TypeError("Workspace branch validation requires a callable utf8ByteLength port.")`
for an absent or noncallable binding. It invokes the byte callback zero times.
A property getter's construction-time exception propagates unchanged. Validation
looks up and calls the port again only after all preceding rules pass; it does
not capture or evaluate a byte count early. Callback failures propagate unchanged.

`src/worktree.ts` retains the public `validateBranchName(branch: string): string`
facade. Each invocation composes the application with the arrow
`(value) => Buffer.byteLength(value, "utf-8")` and invokes the returned validator.
The arrow accesses the current native `Buffer.byteLength` when the final stage
runs. Importing the facade or rejecting an earlier rule does not call it.
The application has no ambient Buffer, filesystem, path, Git or process access.

## Preserved validation order

The first matching rule throws its existing `Error`. Messages interpolate the
original branch where shown; successful validation returns that original value
unchanged.

| Order | Rejection | Exact message |
| --- | --- | --- |
| 1 | Falsy input or `branch.trim() === ""` | `Invalid branch name: cannot be empty` |
| 2 | Starts with `-` | `Invalid branch name '${branch}': cannot start with '-'` |
| 3 | Contains `..` | `Invalid branch name '${branch}': cannot contain '..'` |
| 4 | Control characters U+0000–U+001F, DEL, space, `~`, `^`, `:`, `?`, `*`, `[`, `]`, or backslash | `Invalid branch name '${branch}': contains forbidden characters` |
| 5 | Contains `@{` | `Invalid branch name '${branch}': cannot contain '@{'` |
| 6 | Starts or ends with `/` | `Invalid branch name '${branch}': cannot start or end with '/'` |
| 7 | Contains `//` | `Invalid branch name '${branch}': cannot contain consecutive slashes` |
| 8 | Ends with `.lock` | `Invalid branch name '${branch}': cannot end with '.lock'` |
| 9 | Ends with `.` | `Invalid branch name '${branch}': cannot end with '.'` |
| 10 | `ports.utf8ByteLength(branch) > 255` | `Invalid branch name: too long (max 255 bytes)` |

The 255-byte limit is inclusive and counts native UTF-8 bytes, including native
handling of multibyte characters, astral characters and lone surrogates. The
application trusts the supplied byte callback; the facade supplies real native
UTF-8 counting.

No trimming, case folding, coercion or full Git ref normalization is added.
Existing quirks remain: `@`, `.hidden`, and `feature/.hidden` pass these rules,
as does `feature.lock/child` because only the whole branch suffix is checked.
The TypeScript signature accepts strings, while out-of-contract runtime inputs
retain their original behavior: falsy values get the empty-name error; truthy
nonstrings may throw their original string-method TypeError; boxed strings can
reach and fail native Buffer counting. Exceptions are not converted or rescued.

## Retained ownership and verification boundaries

`createWorkspace`, `removeWorkspace` and the CLI's `prepareWorktreeUnlocked`
continue to call the public facade at their existing validation points. Native
path resolution, filesystem effects, Git operations and private helper ownership
stay with their current callers. All create, remove and repair ownership fences,
registration checks, refusal behavior, preservation and rollback logic remain
in their existing native orchestration. A branch passing this validator does
not establish workspace ownership or authorize an operation.

Required source verification covers exact rules and precedence, callable guards,
late callback lookup and invocation, exception identity, raw runtime inputs,
real UTF-8 thresholds, facade signatures, strict type contracts and the recursive
core boundary. Existing create/remove guards and compiled CLI rejection before
workspace mutation or container launch also require verification. Independent
document consistency review must compare this guide with the actual application,
port and facade.

The parent combined package verifier must execute the actual compiled application
and public facade with a real UTF-8 byte callback from both an extracted npm
payload and a materialized installation. It must also compile a strict consumer
of the emitted declarations to prove the factory, required readonly callable
port, returned validator and preserved public signature. Source tests or source
type imports alone do not establish delivered artifact compatibility.

These are acceptance requirements, not a record that the checks passed.
Independent review and fresh QA determine the task's acceptance. Portable
fixtures and package checks do not certify native Windows/macOS behavior, full
workspace creation/removal/repair migration, or broader M11–M14 completion.
