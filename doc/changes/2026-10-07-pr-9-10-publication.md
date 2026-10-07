# PR #9 and #10 publication

Both existing pull requests were merged, in order, into
`feature/device-mcp-squashed` on 2026-10-07. Master was not modified.

- [PR #9](https://github.com/Luxusio/claude-code-container/pull/9):
  `e576d4abe16158b2dae2f028daa092db9984c2ff`; selected-tool cache and wrapper recovery.
- [PR #10](https://github.com/Luxusio/claude-code-container/pull/10):
  `c95d7e40dd5a577eb8085a89c815f7908d5278e7`; architecture-compatible upstream ownership/session integration.

## Publication proofs

GitHub read-back confirmed `merged: true` for both PRs and the intended base.
Original PR heads remain ancestors of the final merge. All pushes were ordinary
fast-forwards; no force push, squash substitution or Close-only action occurred.
The PR #9 merge tree matched independently reviewed S exactly. The PR #10
merge tree matched reviewed Q plus the separately reviewed and tested recipe
correction exactly. Final product tree: `3a53ea7bfe11ce53b48fcc6b2e4b937913007bbd`.

The local original architecture branch was fast-forwarded to the actual GitHub
merge. All 97 pre-existing dirty files were accounted for: unrelated bytes
were preserved, and three overlapping EOL-only files retained their previous
line-ending style with the new merged contents. The unrelated substantive
container-init/socket-access requirement edit remains uncommitted.

## Verification and limits

The full original Q candidate passed independent code/security/documentation
reviews, build/type/lint/package checks and 9,188 tests with 146 skipped.
S independently passed its reviews, build/shipping checks and 125 focused tests.
Publication CI exposed missing Codex package-volume ownership in Containerfile.
The correction makes it byte-identical to the unchanged reviewed Dockerfile;
independent narrow code review, recipe equality/ownership/hash checks and the
existing recipe dependency fixture passed.

[CI run 37552673637](https://github.com/Luxusio/claude-code-container/actions/runs/37552673637)
ran on the pre-correction PR #10 head `c07cfaeb9854bbd30f6a098a7dd5291a7f9c9a48`.
Chrome-devtools passed; Podman recipe equality failed and was corrected before
merge. Windows worktree tests failed eight cases during creation/rollback;
`src/worktree.ts` and the exercised test region were unchanged from the
architecture base. Rootless Podman E2E failed four lifecycle cases. The general
Linux test job was still running at this checkpoint. These CI results are not
reported as a fully green pipeline; the native failures remain follow-up work,
and unchanged source alone does not establish their root cause.

The target branch had no mandatory protection/check gate. Its existing CI
workflow filters PR bases to master, so the final corrected feature-targeted
head did not acquire a replacement run automatically. No CI gate was disabled
or workflow modified. Native Windows/macOS/Hyper-V/device and live runtime
acceptance are not established by local Linux fixture evidence.

## Explicit receipt exception and retained evidence

After actual independent review and QA passed, Harness lifecycle receipts were
missing and strict source tasks could not close. The operator explicitly
approved a publication exception for these two PRs. No receipt or strict PASS
was fabricated. Harness source tasks retain their truthful blocked state.

Private reviewed source checkouts are retained at
`/tmp/ccc-pr9-slice-01a111dd` and `/tmp/ccc-pr-integration-01a111dd` because strict
source close remains blocked. Their source changes are committed and represented
in the actual merges. The ignored byte-verified candidate archive is under
`doc/harness/checkpoints/pr-9-10-reviewed-candidates-2026-10-07`; do not expose
private fixture payloads or credentials. Close/dispose under a supported receipt
workflow or a separately explicit cleanup exception.
