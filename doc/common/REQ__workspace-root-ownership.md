# Workspace root ownership when reusing a ccc workspace

## Intent

When `ccc` finds an existing sibling workspace for a branch, it reuses that
directory only after Git confirms that the source repository owns the linked
worktree. A failed check must give the operator enough information to inspect
the workspace without risking uncommitted files.

## Required behavior

- A live `.git` link, its worktree management entry, the management entry's
  backpointer, the source common Git directory, and Git's worktree registry
  must refer to the same worktree. A relative backpointer is resolved from the
  management entry directory when the installed Git version supports relative
  worktree links and does not mark the registration prunable.
- On Windows, alternate spelling of an existing path may pass only when the
  paths resolve to the same observed filesystem object. Case-insensitive text
  comparison alone does not establish ownership. A Git backpointer or registry
  path must also directly name that path, so a symlink alias cannot establish
  ownership. Windows short (8.3) and expanded path spellings may agree only
  after native canonical paths agree, every ancestor is observed without a
  symbolic link or junction, and a nonzero inode, matching device, and object
  type confirm the same existing object. Hard links and junction aliases must
  not establish direct ownership. The same object checks apply to stale
  backpointer repair and tracked nested worktree mounts. Existing Windows
  identity captures and containment/relative-link calculations use native
  expanded paths consistently. Canonical spelling does not replace filesystem
  identity, direct-path, branch, or metadata generation checks. Recovery
  creates its temporary registration beside the observed workspace path so
  the missing destination still agrees with Git after temporary cleanup.
- A workspace owned by another repository, a copied or forged `.git` link, or
  missing or ambiguous Git evidence must be refused before launch. The CLI
  must not delete, adopt, or rewrite that directory as part of this refusal.
- The refusal names both the workspace and source and shows how to inspect the
  source's worktree list and the workspace's `.git` file. If the checkout was
  moved and its source ownership is confirmed, it may suggest `git worktree
  repair` as the next step. The wording must make that condition clear.
- If the workspace `.git` link names a missing worktree management entry in the
  source repository, the refusal must distinguish that case from a moved
  registered worktree. `ccc` may offer to recreate the missing entry only when
  the workspace is at the exact expected branch path, its `.git` link names the
  source repository's worktree management root, the branch exists, and no live
  checkout owns that branch. The action requires explicit confirmation.
- Confirmed recovery creates and validates a temporary Git registration and
  index, then relinks that registration to the existing workspace. It preserves
  tracked modifications, untracked files, and ignored files. Any failed
  validation rolls metadata back; declining the prompt changes nothing.
- The recreated management `gitdir` backpointer is an absolute path. On
  Windows it uses forward slashes, matching Git's administrative path format.
  The workspace `.git` forward link may remain relative for portability.
- If confirmed recovery fails, the CLI names the failing registration or
  validation step, including the specific post-relink ownership invariant,
  and includes Git's concise error when available. Equivalent
  Windows paths must pass the same observed-object checks during recovery as
  during preflight. A failed attempt preserves the workspace files. Worktree
  creation diagnostics retain the original failure message when Git stderr is
  empty, including registration ownership capture failures before checkout.

## Verification

Use real temporary Git repositories and worktrees to cover owned, relative
backpointer, stale metadata, missing management entry, foreign, and forged
cases. Missing-entry coverage includes declined recovery, confirmed root-only
recovery through the CLI prompt, branch conflict, and rollback. Run the Windows
path spelling (including a real short/expanded path pair) and nested mount
cases on a Windows filesystem. Preserve tracked changes and an untracked
marker across every validation or refusal path.
