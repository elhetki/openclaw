import { fstatSync } from "node:fs";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { bootstrapGatewayMaintenanceOffline } from "../../gateway/maintenance-bootstrap.js";
import type { OutputRuntimeEnv } from "../../runtime.js";

/** Secret receipt is confined to the host launcher's private pipe, never a TTY
 * or a path supplied to this CLI. The host owns durable journaling and fencing. */
export async function runMaintenanceBootstrapCli(runtime: OutputRuntimeEnv): Promise<void> {
  for (const fd of [0, 1]) {
    const stat = fstatSync(fd);
    if (!stat.isFIFO() && !stat.isSocket()) {
      throw new Error("Maintenance bootstrap requires private stdin and stdout pipes");
    }
  }
  const timeout = setTimeout(
    () => process.stdin.destroy(new Error("Maintenance bootstrap input timed out")),
    10_000,
  );
  let input: Buffer;
  try {
    input = await readByteStreamWithLimit(process.stdin, { maxBytes: 8192 });
  } finally {
    clearTimeout(timeout);
  }
  const request: unknown = JSON.parse(input.toString("utf8"));
  const receipt = await bootstrapGatewayMaintenanceOffline(request);
  runtime.writeJson(receipt);
}
