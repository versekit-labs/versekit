import { fileURLToPath } from "node:url";

// Include plugin tests in the existing runner and its temporary directory checks.
if (!process.env.VK_TEST_ALL_FILES) {
  process.argv.push(
    fileURLToPath(new URL("./handoff.test.mjs", import.meta.url)),
    fileURLToPath(new URL("./version.test.mjs", import.meta.url)),
  );
}
await import("../../../scripts/ci/test-all.mjs");
