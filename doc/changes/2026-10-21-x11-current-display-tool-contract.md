# X11 input results and advertised capabilities

The [current-display contract](../device-lab/REQ__x11-current-display-tool-contract.md)
requires desktop key aliases to reach X11 key names and an ignored unknown key to
return an error even when xdotool exits zero. Default flows stop at that failure.
Focus is advertised only after bounded native readback establishes support; focus
actions still verify the actual target. Unsupported tools for the known current
display return a local unsupported diagnostic instead of broker device-not-found.

Native event checks use an allocated display and owned window. This change adds
no shared-display isolation, provider, authentication protocol or state migration.
