import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

it("persists maintenance through the real host writer broker", async () => {
  const result = await runNodeScript(
    (workerArgv) =>
      workerArgv(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "gateway-maintenance-store.test-support",
          distWorkerPath: "infra/gateway-maintenance-store.test-support.js",
        }),
      ),
    process.env,
    undefined,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
