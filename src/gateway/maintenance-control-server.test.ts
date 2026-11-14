import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

it.each(["public", "cold", "reject-config", "reject-plugin"])(
  "keeps maintenance ingress closed through its actual entry (%s)",
  async (mode) => {
    const result = await runNodeScript(
      (workerArgv) => [
        ...workerArgv(
          resolveRuntimeWorkerUrl({
            currentModuleUrl: import.meta.url,
            sourceWorkerName: "maintenance-control-server.test-support",
            distWorkerPath: "gateway/maintenance-control-server.test-support.js",
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
