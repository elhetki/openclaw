import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

it.each(["restart", "session", "transcript", "home"])(
  "reconciles released receipt offline: %s",
  async (mode) => {
    const result = await runNodeScript(
      (argv) => [
        ...argv(
          resolveRuntimeWorkerUrl({
            currentModuleUrl: import.meta.url,
            sourceWorkerName: "maintenance-released-receipt.test-support",
            distWorkerPath: "gateway/maintenance-released-receipt.test-support.js",
          }),
        ),
        mode,
      ],
      process.env,
      undefined,
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
);
