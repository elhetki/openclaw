import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryWorkerRead } from "../config/sessions/session-entry-read-runtime.types.js";
import type { SessionExactEntriesWorkerResult } from "../config/sessions/session-entry-read.types.js";
import type {
  GatewayMaintenanceBinding,
  GatewayMaintenanceReceipt,
} from "../infra/gateway-maintenance-state.js";

export function gatewayMaintenancePhysicalRead(
  binding: GatewayMaintenanceBinding,
  storePath: string,
  env: NodeJS.ProcessEnv,
): SessionEntryWorkerRead {
  return {
    agentId: binding.agentId,
    storePath,
    env,
    sessionKeys: [binding.sessionKey],
    projection: "exact",
    includeAuthorization: true,
    transcript: {
      sessionKey: binding.sessionKey,
      entryIds: [],
      includeSession: true,
      includeHeader: true,
      includeWatermark: true,
      includeMessagePresence: true,
      contextAuthority: true,
    },
  };
}

export async function withGatewayMaintenancePhysicalReceipt<T>(
  context: {
    read: SessionEntryWorkerRead;
    assertCurrent: () => void;
    planned: GatewayMaintenanceReceipt;
    binding: GatewayMaintenanceBinding;
  },
  consume: (receipt: GatewayMaintenanceReceipt, assertCurrent: () => void) => Promise<T>,
) {
  return withSessionEntriesFromStoreInWorker(context.read, async (read) => {
    const assertCurrent = () => {
      context.assertCurrent();
      read.assertCurrent();
    };
    assertCurrent();
    assertGatewayMaintenancePhysicalReceipt(
      context.binding,
      context.planned,
      read.result,
      read.database.agentId,
    );
    return await consume(context.planned, assertCurrent);
  });
}

/** Shared invariant for the retained live reader and exclusive offline snapshot. */
export function assertGatewayMaintenancePhysicalReceipt(
  binding: GatewayMaintenanceBinding,
  planned: GatewayMaintenanceReceipt,
  result: SessionExactEntriesWorkerResult,
  agentId: string,
): void {
  const row = result.entries.length === 1 ? result.entries[0] : undefined;
  const transcript = result.transcript;
  const header = transcript?.header;
  if (
    agentId !== binding.agentId ||
    !row ||
    row.sessionKey !== binding.sessionKey ||
    row.entry.sessionId !== planned.sessionId ||
    row.entry.lifecycleRevision !== planned.lifecycleRevision ||
    row.entry.activeWriterRunId ||
    transcript?.contextAuthority?.entry?.activeWriterRunId ||
    transcript?.session?.sessionId !== planned.sessionId ||
    transcript.session.lifecycleRevision !== planned.lifecycleRevision ||
    !isRecord(header) ||
    header.type !== "session" ||
    header.id !== planned.sessionId ||
    !transcript.watermark?.generation ||
    transcript.watermark.maxSeq !== 0 ||
    transcript.messagePresence !== false
  ) {
    throw new Error("Maintenance physical session receipt or emptiness does not match");
  }
}
