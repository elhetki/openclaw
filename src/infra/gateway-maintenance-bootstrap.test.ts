import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

it("atomically bootstraps offline and reconciles only the exact request after a lost acknowledgment", async () => {
  const result = await runNodeScript(
    (workerArgv) =>
      workerArgv(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "gateway-maintenance-bootstrap.test-support",
          distWorkerPath: "infra/gateway-maintenance-bootstrap.test-support.js",
        }),
      ),
    process.env,
    undefined,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
