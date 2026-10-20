# Codex startup tolerates disappeared state entries

The startup access probe previously treated a socket disappearing after directory
enumeration as a state ownership failure. It now distinguishes missing descendants
from retained inaccessible entries at the shared filesystem observation boundary,
including file access and child-directory traversal. No socket name is exempted.

Root checks, private ownership checks and real filesystem errors remain strict.
The probe performs no ownership or state changes. The mutating migration and
Windows recovery are unchanged. See the [access probe contract](../credentials/REQ__codex-state-access-probe.md).

Qualification uses actual exported Python and private deterministic filesystem
fixtures, including real socket removal. Actual Mac acceptance and the separate
SSH copy warning require native evidence; this correction does not certify either.
