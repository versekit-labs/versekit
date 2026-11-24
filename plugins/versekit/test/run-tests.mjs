import { fileURLToPath } from "node:url";

// Include the plugin in the existing test runner so it gets the same temporary directory and cleanup checks.
if (!process.env.VK_TEST_ALL_FILES) process.argv.push(fileURLToPath(new URL("./handoff.test.mjs", import.meta.url)));
await import("../../../scripts/ci/test-all.mjs");
