# Installed diagnostics use a private home

An installed MCP diagnostic must run its child with a temporary private home on every supported host. `HOME`, `USERPROFILE` and Windows `HOMEDRIVE`/`HOMEPATH` must identify that same home; omitted variables must not restore the invoking user's profile. Temporary application directories must remain inside the diagnostic fixture.

The diagnostic must not inherit user credentials or write child state into the caller's real home. Restore and preserve the caller's environment. Verify the exact child home relationship, including native Windows `os.homedir()`, rather than only asserting that a hostile sentinel changed.
