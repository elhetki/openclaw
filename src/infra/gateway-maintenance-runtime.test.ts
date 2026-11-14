import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

it("binds durable maintenance to its coordinator and drains admitted work through the dispatcher", async () => {
  const result = await runNodeScript(
    (workerArgv) =>
      workerArgv(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "gateway-maintenance-runtime.test-support",
          distWorkerPath: "infra/gateway-maintenance-runtime.test-support.js",
        }),
      ),
    process.env,
    undefined,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
