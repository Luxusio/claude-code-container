# SSH credential publication and failure stages

SSH refresh now normalizes the caller-owned extracted stage before writing known-host provenance. Restrictive source directory/file modes no longer make that internal step fail solely because permissions are normalized too late; failure cleanup prepares only managed copy directories for removal. Host source permissions and link targets remain unchanged. The existing best-effort refresh warning can identify one of eight fixed failure stages without exposing native output or credential contents. Required Git signing and completed-copy-only key rewriting remain unchanged; no unsigned retry is introduced. The contract is [completed SSH copies and signing](../credentials/REQ__ssh-copy-publication.md), refining the earlier generic-warning-only requirement.

The Mac report establishes an existing mounted key, a refresh failure and no completed copy. The restrictive-mode failure was separately reproduced with a synthetic fixture using the privileged-read tar branch. That reproduction does not establish which stage failed on the Mac. Portable transfer/rewrite/Git-signer checks establish path selection and a failed signed commit, not cryptographic signing or native Mac authentication.

## Known ceiling

Native Mac correlation remains pending. Source-tree churn, cross-startup races, encrypted/hardware keys, agent transport and a whole-operation timeout remain outside this change. Unknown native failure codes retain the generic warning. An OS-denied cleanup remains a failure; removal is not guaranteed for foreign-owned or otherwise unremovable old paths. No installation or real provider lifecycle operation is claimed.
