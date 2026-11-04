// Synthetic fixture: if discovery or preflight ever executed a package
// script, this marker file would appear and the tests would fail.
import fs from "node:fs";

fs.writeFileSync(new URL("../EXECUTED-MARKER", import.meta.url), "executed\n");
