import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

it("pairs Home only with an exact durable pending receipt and reconciles its lost reply", async () => {
  const result = await runNodeScript(
    (workerArgv) =>
      workerArgv(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "gateway-maintenance-home.test-support",
          distWorkerPath: "infra/gateway-maintenance-home.test-support.js",
        }),
      ),
    process.env,
    undefined,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
