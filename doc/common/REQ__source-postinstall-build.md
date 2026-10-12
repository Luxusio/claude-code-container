# Source installation must report build failure

Installing dependencies in the source repository must build the CLI successfully
before npm reports success. A failed build must propagate its error and give the
postinstall process a nonzero exit status. A warning followed by success leaves
old compiled code available and must not be used as proof that fixes are installed.

Postinstall from an npm package still skips the build because that package ships
its compiled artifacts. Successful source postinstall performs only the source
build; it does not build a container image, install a global launcher, or edit PATH.
Failure handling must not delete a previously usable CLI or alter runtime/session
lock ownership. Dependency installation with explicit `--ignore-scripts` remains
an opt-out; callers must complete `npm run build` before using source artifacts.

Verify these behaviors through the real installer subprocess tests in
`src/__tests__/install-global.test.ts`, with source and packaged fixtures.
