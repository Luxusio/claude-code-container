"use strict";

// Unit fixtures need direct paths: macOS commonly exposes its temporary root
// through /var, while Git and Node's module loader report /private/var.
// Keep the production symlink checks intact by canonicalizing only this base.
if (process.platform !== "win32") {
    process.env.TMPDIR = require("node:fs").realpathSync(require("node:os").tmpdir());
}
