import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state-row.js";
import { writeConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { approveDevicePairingInWorker } from "./device-pairing-approval.kernel.js";
import { requestDevicePairingInWorker } from "./device-pairing-core.kernel.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "./device-pairing-identity.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import { loadDevicePairingStateForMutation } from "./device-pairing-state.kernel.js";
import { verifyGatewayMaintenanceBootstrapRequest } from "./gateway-maintenance-bootstrap-request.js";
import {
  gatewayMaintenanceStateKey,
  parseGatewayMaintenanceState,
  transitionGatewayMaintenance,
} from "./gateway-maintenance-state.js";

/** Called only inside the canonical pairing transaction. Pairing, token issuance,
 * begin intent, and the retry receipt are one atomic commit, never a network grant. */
export function bootstrapGatewayMaintenanceInWorker(
  input: { request: unknown; ownerInstanceId: string },
  database: OpenClawStateDatabase,
) {
  const { request, deviceId } = verifyGatewayMaintenanceBootstrapRequest(input.request);
  const now = Date.now();
  const row = readConfigMachineStateRowInDatabase(database.db, gatewayMaintenanceStateKey);
  let state = parseGatewayMaintenanceState(row ? JSON.parse(row.value_json) : undefined);
  const pairing = loadDevicePairingStateForMutation(now);
  let device = pairing.pairedByDeviceId[deviceId];
  const scopes = ["operator.admin"];
  // First installation only. A released generation must never become authority
  // to replace/reissue the coordinator through this offline bootstrap path.
  if (state) {
    const token = device?.tokens?.operator?.token;
    const identity = token
      ? resolveAuthenticatedDeviceTokenIdentity(device ?? null, {
          role: "operator",
          publicKey: request.publicKey,
          token,
          scopes,
        })
      : null;
    if (
      state.phase !== "draining" ||
      state.requestId !== request.requestId ||
      state.binding.deviceId !== deviceId ||
      state.binding.publicKey !== request.publicKey ||
      state.binding.agentId !== request.agentId ||
      state.binding.sessionKey !== request.sessionKey ||
      !identity ||
      state.binding.tokenIdentityKey !== identity.key ||
      device?.tokens?.operator?.issuer
    ) {
      throw new Error(
        "Maintenance bootstrap receipt does not match this exact request and credential",
      );
    }
  } else {
    if (device || Object.values(pairing.pendingById).some((entry) => entry.deviceId === deviceId)) {
      throw new Error("Maintenance bootstrap requires a new coordinator identity");
    }
    const pending = requestDevicePairingInWorker(
      {
        deviceId,
        publicKey: request.publicKey,
        role: "operator",
        scopes,
        clientId: "cli",
        clientMode: "cli",
        platform: "linux",
      },
      now,
    );
    const approved = approveDevicePairingInWorker(
      pending.request.requestId,
      { callerScopes: scopes, approvedVia: "owner" },
      now,
    );
    if (approved?.status !== "approved") {
      throw new Error("Maintenance coordinator pairing refused");
    }
    device = approved.device;
    const token = device.tokens?.operator?.token;
    const identity = token
      ? resolveAuthenticatedDeviceTokenIdentity(device, {
          role: "operator",
          publicKey: request.publicKey,
          token,
          scopes,
        })
      : null;
    if (!identity) {
      throw new Error("Maintenance coordinator token unavailable");
    }
    state = transitionGatewayMaintenance(undefined, {
      action: "begin",
      requestId: request.requestId,
      ownerInstanceId: input.ownerInstanceId,
      binding: {
        deviceId,
        publicKey: request.publicKey,
        tokenIdentityKey: identity.key,
        agentId: request.agentId,
        sessionKey: request.sessionKey,
      },
    });
    writeConfigMachineStateInDatabase(database.db, gatewayMaintenanceStateKey, state);
  }
  requestDevicePairingMutationAdmission({
    kind: "maintenance-bootstrap",
    requestId: request.requestId,
    deviceId,
    agentId: request.agentId,
    sessionKey: request.sessionKey,
  });
  const token = device?.tokens?.operator?.token;
  if (!token) {
    throw new Error("Maintenance coordinator token unavailable");
  }
  return {
    version: 1 as const,
    state,
    credential: { deviceId, publicKey: request.publicKey, role: "operator" as const, token },
  };
}
