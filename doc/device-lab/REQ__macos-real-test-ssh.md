# Mac real-test SSH selection

Status: derived repair contract, 2026-10-28.

The standing request is to repair saved Mac provider failures using focused
verification. The product already defines SSH defaults for recognized Tart
images in its [lifecycle policy](../../packages/device-lab/providers/domain/lifecycle/macos-vm-lifecycle.mjs).
Previously, the real E2E's default path supplied a project-derived user and a
host-local key, generating the key if missing without installing it in the guest. The following choice
aligns the real test with the existing product behavior; it does not introduce
new guest credentials or establish the saved connection failure's cause.

For an image recognized by that existing policy, with no explicit real-test SSH
configuration, omit SSH overrides from `create_macos_vm`. Derive the expected
guest user from the same policy. Keep SSH availability and all guest assertions
enabled, and do not generate a local key for that path.

Explicit primary or compatibility SSH user, host, port, key-path and default-user
settings retain their existing precedence and behavior. Unrecognized/custom
images retain their existing behavior; do not guess a new guest account, install
a key, weaken authentication or change guest configuration. No new password
setting or public tool field is introduced.

Verify recognized-image creation without overrides or key generation, the
expected policy user with guest checks still enabled, and explicit override and
custom-image behavior. Use private environment/native-command fixtures. The
actual host image list confirms availability, not guest SSH authorization;
native current-MCP guest acceptance remains required separately.
