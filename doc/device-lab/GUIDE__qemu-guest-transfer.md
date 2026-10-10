# QEMU guest transfer

`createQemuGuestTransferApplication` owns synchronous push/pull admission, guest-path and copy-limit decisions, transport requests, dry-run/refusal results, cleanup choice and bounded operation history. Native composition supplies the selected owner lab, canonical path containment, file/link/content scanning, directory copy/removal and the existing bounded transport runner. Current lifecycle and public lab projections remain inward peers.

Push scans before copying into the lab workspace and removes that staged workspace on returned transport failure. Pull retains its existing non-atomic behavior: it can replace and materialize the destination before transport, then scans the received content. Returned transport or policy failure removes the destination; a thrown transport, cleanup or publication error remains an exception with its existing partial effects. No new rollback or atomic stage was added.

The factory requires explicit synchronous effects; it does not invoke the old native push/pull workflow or expose native context. The facade retains trusted owner storage, filesystem guards, SSH/session authority and publication mechanisms. Ordinary application and existing public provider tests can cover those current outcomes; portable tests do not certify a real native guest. This QEMU cohort alone does not complete global upload/download coverage.
