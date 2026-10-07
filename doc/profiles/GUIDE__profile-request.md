# Profile request policy

[`src/domain/profile-request.ts`](../../src/domain/profile-request.ts) owns the
canonical `DEFAULT_PROFILE_NAME` literal (`"default"`) and the pure
`normalizeProfile(profile?: string): string | undefined` rule. It has no imports,
host observations, filesystem effects or name validation.

The rule is exactly `profile && profile !== DEFAULT_PROFILE_NAME ? profile :
undefined`. Omitted input, `undefined`, an empty string and the exact string
`"default"` mean the default profile. Every other string keeps its spelling,
including whitespace, case variants, Unicode and path-like text. This function
does not establish that a profile name is safe or valid.

[`src/home-layout.ts`](../../src/home-layout.ts) retains its exported constant
declaration, inferred literal type and optional-string public wrapper. It delegates
normalization to the domain. Existing callers continue to import the native
facade. Profile paths, legacy/default resolution, the default marker, migration,
locks and credential layout remain native responsibilities in that module.
CLI name validation and profile catalog validation retain their own ownership.

Untyped JavaScript callers retain the existing truthiness and strict-equality
behavior: falsy values normalize to `undefined`; truthy values pass through by
identity. Normalization invokes no coercion hooks, so a boxed `"default"` is not
the default string. A truthy nonstring reaching a native profile path helper
still fails at native path handling. The TypeScript signature accepts only an
optional string; these JavaScript compatibility checks do not widen it.

## Verification

- `profile-request-domain.test.ts` covers default aliases, unchanged arbitrary
  strings, JavaScript identity/coercion and imports with native dependencies fenced.
- `profile-request-facade.test.ts` spies on the actual domain module, proves
  forwarding and returned results, exception propagation, unchanged facade exports
  and retained native path errors.
- `profile-request-types.test.ts` checks domain and facade signatures and default
  literal types, including deliberately invalid compile-time consumers. Its facade
  import is type-only. `tsconfig.architecture.json` includes these consumers.
- The existing recursive architecture guard checks the new domain module.
  Existing home-layout, profile, utils, remote and Codex lock suites cover callers
  using private home fixtures.

Build the isolated worktree with its private dependency installation before
running direct Vitest and architecture typechecking. Direct Vitest avoids the
auto-build wrapper during QA and preserves the reviewed artifacts. The
coordinator owns combined emitted-declaration and compiled, extracted and
materialized package verification; a source test alone does not prove shipping.

## Known ceiling

Known ceiling: Portable policy and private-home Linux tests do not certify native
Windows/macOS execution or the whole profile/home-layout architecture migration
— upgrade when those platform or broader migration claims are required.

This extraction completes only the profile request rule. Use the existing
[architecture ADR](../common/ADR__ccc-target-architecture.md),
[contracts](../common/SPEC__ccc-architecture-contracts.md) and
[migration work packets](../common/PLAN__ccc-architecture-migration.md) for the
remaining native boundaries.
