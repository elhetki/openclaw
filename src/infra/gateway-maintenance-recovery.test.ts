import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

it("revalidates recovery against the durable exact coordinator token in the host writer", async () => {
  const result = await runNodeScript(
    (workerArgv) =>
      workerArgv(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "gateway-maintenance-recovery.test-support",
          distWorkerPath: "infra/gateway-maintenance-recovery.test-support.js",
        }),
      ),
    process.env,
    undefined,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
