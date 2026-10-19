# Installed CLI Node runtime

The Unix global CCC installation uses the absolute Node executable that ran its
installer. A project's PATH, mise configuration or older Node version must not
silently change the installed CCC runtime. Project tool versions stay unchanged.

The installer requires Node >=20.19.0 before building source or publishing a
launcher. Unsupported Node reports its version and the required minimum.
The launcher executes the installed entry point with literal arguments and
inherited terminal streams; exit status and process signals are preserved.
Paths containing spaces, apostrophes or shell metacharacters remain literal.

Removing the selected Node installation requires reinstalling CCC using a
supported Node. Never silently fall back to another executable on PATH.
This change does not add Node 16 support or change the Windows launcher.

Verify with a private installation: put an incompatible node shim first on PATH,
execute CCC directly, and prove that the shim is not called. Exercise literal
arguments, streams, exit and signal behavior, and unsupported installer refusal
before build/publication. macOS execution remains a separate host check.
