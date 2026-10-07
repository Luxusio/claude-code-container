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
without removing ownership gates. The ed9d288a run completed with Linux,
Podman-forced units and Chrome passing; native Windows and Podman E2E failed.

## Known ceiling

Source review inspected the uncommitted correction against exact base
`1a6cf91bb1651e0f2a8f9352dcb2adad89d85db8`; a final correction SHA is not
claimed before commit. Local isolated Linux build passed; the clipboard/SDK
focused run passed 90 cases and fresh foundation run passed 10 cases.

Device Lab created and booted Windows Server guest `ccc-native-ci-20261007`,
incarnation `1d242aa71a4cffa99cae75516d956e92`. Node24.21.0 and Git2.55.0 were
downloaded with verified checksums. Installation and explicit build for the
ed9d288a source completed successfully; its Windows subset failed. Acceptance
for the subsequent Windows/Podman corrections, final exact-SHA CI and exact-
device cleanup remain pending. No Linux fixture substitutes for native outcomes.

Fresh full-suite QA also exposed an Android boot-exit fixture race. Establish
its pending-boot marker before starting the fake emulator so an early adb poll
cannot report boot-ready before the child initializes. Preserve the child exit
17, stopped-state rollback, and cleared runtime/lifecycle assertions.

## Native diagnosis and correction

The exact ed9d288a Windows guest source archive was verified against SHA-256
`97cfd0aee82deaf2479dfb3c26fbc0e0e8286384c1cbd0e0a39d9dbfd5280a85`.
Both native dependency installation and explicit `npm run build` exited 0;
Windows worktree tests exited 1. Remaining path fixes canonicalize captured
Windows observations before containment/relative-link relationships and use
Git's valid forward-slash administrative backpointer format. They preserve
object/no-link proof and rollback. Corrected native results remain pending.

The ed9d288a CI Linux, Podman-forced unit and Chrome jobs passed. Native
Podman diagnostics proved inspection failed because its default `rprivate`
and `tmpcopyup` flags were rejected. Accept exactly those two benign defaults
without dropping hardening flags or unknown/shared/conflicting-option refusal.
Create/reuse inspection regressions passed 21 focused tests, including captured
identity and exact-ID compensation. Native lifecycle acceptance remains pending.

The next Windows source/test overlay was byte-verified in the guest against
SHA-256 `4b2ed752269bfd2a7a0b7bad0efad3ddee21f67a9fe8c1915317e134b4e2d5c5`
and `f439d6b75e7d3b5fcff8d9f9b344700214468ab8f4bf3db3d324f65f0cc8a604`.
Its previously failing alternate-case backpointer regression passed natively.
The whole corrected native subset and final CI remain pending at this checkpoint.

## Remaining native failures resolved in source

A bounded guest-only diagnostic showed temporary HEAD observation exiting 128
with `fatal: '$GIT_DIR' too big`; the source branch OID and administrative HEAD
contents matched. The first bounded-name correction used `.ccc-register-<32hex>` rather than
repeating the whole workspace basename. Unique creation and every identity, branch/OID,
final validation and rollback fence remain. Git observation errors are reported
separately from successful observations whose OID changed.

Podman's absent `DeviceRequests` inspection field is normalized only when the
selected runtime is Podman, never by trusting payload runtime labels. Docker
missing fields and malformed/nonempty requests or injected devices remain
refused. Native-shaped reuse fixtures passed 12 focused cases. Short CCC
commands intentionally stop their container after the last session ends; E2E
now verifies that state and starts only its captured owned container ID before
checking public `stop`. Corrected native and fresh final QA remain pending.

## Repeated-recovery binding

The final bounded name is `.ccc-register-<12hex workspace digest>-<32hex nonce>`.
Its digest binds the observed canonical workspace path and device/inode; only
its exact bound format or a legacy workspace-derived name can recover. Windows
case aliases retain the same digest while distinct objects remain separate.
Two successive registration losses/recoveries preserve tracked, untracked and
ignored content with a stable digest and fresh nonce. Another workspace's
binding is refused without changing the target. Nine focused cases passed;
final corrected native and fresh full QA remain pending.

The final bound-name source/test overlay was byte-verified in the actual
Windows guest against SHA-256
`b64ac1f357d82eff7f3094031b3d41f15e10c18c212ef4e7eade4770310e9fe9`
and `51b404c0173829e9bb28df5eafa8678fc7eabeb5993755f8027d81b70ab57d04`.
The long-name confirmed recovery and native short/expanded/case recovery
regressions passed (2 passed, 0 failed), including repeated recoveries and
file preservation. Exact committed full native CI/build and fresh whole QA
remain pending at this checkpoint.
