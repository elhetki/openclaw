import { randomUUID } from "node:crypto";
import { listAgentIds } from "../agents/agent-scope.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../config/io.js";
import { initializeSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { executeDevicePairingMutation } from "../infra/device-pairing-worker.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { verifyGatewayMaintenanceBootstrapRequest } from "../infra/gateway-maintenance-bootstrap-request.js";
import { holdGatewayMaintenanceAdmission } from "../process/gateway-work-admission.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

/** Explicit offline one-shot, never an RPC or automatic startup action.
 * The host must durably record its request and hold ordinary service/foreign-writer
 * custody before launch. This lock fences canonical OpenClaw owners, not arbitrary
 * same-UID filesystem writers. Return the credential only over the host's private
 * pipe; never give the signing key to the principal. The process must exit after use. */
export async function bootstrapGatewayMaintenanceOffline(value: unknown) {
  const { request, deviceId } = verifyGatewayMaintenanceBootstrapRequest(value);
  await initializeSqliteRuntimeCapabilities();
  const admission = holdGatewayMaintenanceAdmission();
  const lock = await acquireGatewayLock({ listenerMode: "foreground", allowInTests: true });
  if (!lock) {
    throw new Error("Offline maintenance bootstrap requires exclusive state ownership");
  }
  const databasePath = resolveOpenClawStateSqlitePath();
  const assertCurrent = () => {
    admission.assertCurrent();
    lock.assertDatabaseAccess(databasePath);
  };
  try {
    assertCurrent();
    const { snapshot } = await withArtifactPreservingStateReads(() =>
      readConfigFileSnapshotWithPluginMetadata({
        observe: false,
        isolateEnv: true,
        allowCurrentPluginMetadata: false,
      }),
    );
    assertCurrent();
    if (
      !snapshot.valid ||
      !snapshot.exists ||
      snapshot.config.gateway?.mode === "remote" ||
      !listAgentIds(snapshot.config).includes(request.agentId)
    ) {
      throw new Error(
        "Offline maintenance bootstrap requires a valid local config with its exact agent",
      );
    }
    return await executeDevicePairingMutation(
      {
        type: "devicePairing.bootstrapMaintenance",
        input: { request, ownerInstanceId: randomUUID() },
      },
      {
        assertCurrent,
        admit(fact) {
          if (
            fact.kind === "pairing-approval" &&
            (fact.pending.deviceId !== deviceId ||
              fact.pending.publicKey !== request.publicKey ||
              fact.existing !== undefined)
          ) {
            throw new Error("Maintenance bootstrap pairing target changed");
          }
          if (
            fact.kind === "maintenance-bootstrap" &&
            (fact.deviceId !== deviceId ||
              fact.requestId !== request.requestId ||
              fact.agentId !== request.agentId ||
              fact.sessionKey !== request.sessionKey)
          ) {
            throw new Error("Maintenance bootstrap commit target changed");
          }
        },
      },
    );
  } finally {
    // Failed writer retirement retains state ownership. Never start the ordinary
    // runtime in this process, even after returning a successful receipt.
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    await lock.release();
  }
}
