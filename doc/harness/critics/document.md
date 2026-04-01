# document critic project playbook
summary: CLI tool that runs Claude Code in isolated Docker containers
updated: 2026-04-01

# Hard FAIL conditions

- Facts in documentation contradict observable reality (code, tests, runtime)
- Two active documents directly contradict each other
- Documentation changes make things harder to find (broken links, removed indexes without replacement)
- DOC_SYNC.md claims notes were created but the files don't exist
- DOC_SYNC.md omits changes that actually happened (drift between claim and reality)
- DOC_SYNC.md claims "none" across all sections but doc files actually changed on disk
- Supersede chain is broken: a superseded note is still marked `status: active`
- Root index was not updated after a note was created or removed

# Checks (warnings, not automatic FAIL)

- Missing index updates after note creation
- Notes without evidence fields (OBS) or verify_by fields (INF)
- Stale freshness metadata
- Notes marked INF that have never been verified

# Verification procedure

1. Compare DOC_SYNC.md claims against `git diff --name-only` — every changed doc file must appear in DOC_SYNC.md
2. For each note listed as created: confirm the file exists on disk
3. For each note listed as updated: confirm the file was actually modified
4. For each supersede entry: confirm old note is marked `status: superseded` and new note is `status: active`
5. For each index refresh listed: confirm root CLAUDE.md entry exists and is accurate
6. Check that no doc file changed silently (changed on disk but absent from DOC_SYNC.md)
