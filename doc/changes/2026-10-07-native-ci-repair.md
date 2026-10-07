# Native CI repair

Correct native Windows worktree compatibility with direct short/expanded path
spelling while retaining object identities and rejecting symlink/junction or
hardlink aliases. Preserve original registration failures in diagnostics and
conservative rollback. Real-Git fixture expectations must reflect the observed
registry, including supported relative backpointers and dash-prefixed paths.

Clipboard fixtures must agree on both OS observation APIs; Android discovery
fixtures own and restore SDK environment variables. Missing-state foundation
tests establish a fresh isolated context independently of preceding cases.
Podman E2E retains child exit/error/signal and bounded output before asserting
state so native startup failure is observable.

Native acceptance includes an owner-scoped Device Lab Hyper-V Windows guest
created for this task, headless build/test execution and exact-device cleanup.
Local Linux fixtures do not establish Windows NTFS or rootless Podman behavior.
The workflow now selects the correction branch and feature base for native CI
without removing ownership gates; no completed remote run is claimed yet.

## Known ceiling

Source review inspected the uncommitted correction against exact base
`1a6cf91bb1651e0f2a8f9352dcb2adad89d85db8`; a final correction SHA is not
claimed before commit. Local isolated Linux build passed; the clipboard/SDK
focused run passed 90 cases and fresh foundation run passed 10 cases.

Device Lab created and booted Windows Server guest `ccc-native-ci-20261007`,
incarnation `1d242aa71a4cffa99cae75516d956e92`. Node24.21.0 and Git2.55.0 were
downloaded with verified checksums. The baseline-source guest installation/build
is still in progress. Corrected-source native build/tests, final exact-SHA CI,
rootless Podman acceptance and exact-device cleanup are pending. No Linux
fixture result substitutes for those native outcomes.
