import { fstatSync } from "node:fs";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";

/** Read credentials only from the host-owned bounded private pipe. */
export async function readMaintenancePrivatePipeRequest(): Promise<unknown> {
  for (const fd of [0, 1]) {
    const stat = fstatSync(fd);
    if (!stat.isFIFO() && !stat.isSocket()) {
      throw new Error("Offline maintenance requires private stdin and stdout pipes");
    }
  }
  const timeout = setTimeout(
    () => process.stdin.destroy(new Error("Offline maintenance input timed out")),
    10_000,
  );
  let input: Buffer;
  try {
    input = await readByteStreamWithLimit(process.stdin, { maxBytes: 8192 });
  } finally {
    clearTimeout(timeout);
  }
  const request: unknown = JSON.parse(input.toString("utf8"));
  return request;
}
