import { randomUUID } from "node:crypto";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import { writeConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { deriveDeviceIdFromPublicKey } from "./device-identity.js";
import { approveDevicePairingInWorker } from "./device-pairing-approval.kernel.js";
import { requestDevicePairingInWorker } from "./device-pairing-core.kernel.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "./device-pairing-identity.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import { loadDevicePairingStateForMutation } from "./device-pairing-state.kernel.js";
import {
  readAuthorizedGatewayMaintenanceInDatabase,
  type GatewayMaintenanceAuthority,
} from "./gateway-maintenance-authority.kernel.js";
import {
  gatewayMaintenanceStateKey,
  transitionGatewayMaintenance,
  type GatewayMaintenanceReceipt,
} from "./gateway-maintenance-state.js";

export type GatewayMaintenanceHomeRequest = {
  requestId: string;
  homePublicKey: string;
  agentId: string;
  sessionKey: string;
};

/** Shared-store durable step: never invokes a session writer. Physical creation
 * belongs to the agent store, using the exact planned receipt recorded here. */
export function enrollGatewayMaintenanceHomeInWorker(
  input: GatewayMaintenanceAuthority & {
    ownerInstanceId: string;
    request: GatewayMaintenanceHomeRequest;
    action: "prepare" | "read" | "confirm";
    receipt?: GatewayMaintenanceReceipt;
  },
  database: OpenClawStateDatabase,
) {
  let state = readAuthorizedGatewayMaintenanceInDatabase(database, input);
  const request = input.request;
  const deviceId = deriveDeviceIdFromPublicKey(request.homePublicKey);
  if (
    state.ownerInstanceId !== input.ownerInstanceId ||
    !deviceId ||
    deviceId === state.binding.deviceId ||
    request.agentId !== state.binding.agentId ||
    request.sessionKey !== state.binding.sessionKey ||
    normalizeStoreSessionKey(request.sessionKey) !== request.sessionKey ||
    !["held", "enrollment_pending", "enrolled"].includes(state.phase)
  ) {
    throw new Error("Maintenance Home enrollment authority or target changed");
  }
  const scopes = ["operator.admin"];
  const now = Date.now();
  const pairing = loadDevicePairingStateForMutation(now);
  let device = pairing.pairedByDeviceId[deviceId];
  if (state.phase === "held") {
    if (
      input.action !== "prepare" ||
      state.enrollment ||
      device ||
      Object.values(pairing.pendingById).some((entry) => entry.deviceId === deviceId)
    ) {
      throw new Error("Maintenance Home enrollment requires an absent device");
    }
    const pending = requestDevicePairingInWorker(
      {
        deviceId,
        publicKey: request.homePublicKey,
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
      throw new Error("Maintenance Home pairing refused");
    }
    device = approved.device;
    const token = device.tokens?.operator?.token;
    const identity = token
      ? resolveAuthenticatedDeviceTokenIdentity(device, {
          role: "operator",
          publicKey: request.homePublicKey,
          token,
          scopes,
        })
      : null;
    if (!identity) {
      throw new Error("Maintenance Home credential unavailable");
    }
    state = transitionGatewayMaintenance(state, {
      action: "prepare-enrollment",
      generation: input.generation,
      ownerInstanceId: input.ownerInstanceId,
      enrollment: {
        requestId: request.requestId,
        deviceId,
        publicKey: request.homePublicKey,
        tokenIdentityKey: identity.key,
        planned: { sessionId: randomUUID(), lifecycleRevision: randomUUID() },
      },
    });
    writeConfigMachineStateInDatabase(database.db, gatewayMaintenanceStateKey, state);
  }
  const enrollment = state.enrollment;
  const token = device?.tokens?.operator?.token;
  const identity = token
    ? resolveAuthenticatedDeviceTokenIdentity(device ?? null, {
        role: "operator",
        publicKey: request.homePublicKey,
        token,
        scopes,
      })
    : null;
  if (
    !enrollment ||
    enrollment.requestId !== request.requestId ||
    enrollment.deviceId !== deviceId ||
    enrollment.publicKey !== request.homePublicKey ||
    !identity ||
    enrollment.tokenIdentityKey !== identity.key ||
    device?.tokens?.operator?.issuer ||
    !token
  ) {
    throw new Error("Maintenance Home receipt or credential changed");
  }
  if (input.action === "confirm") {
    if (
      !input.receipt ||
      input.receipt.sessionId !== enrollment.planned.sessionId ||
      input.receipt.lifecycleRevision !== enrollment.planned.lifecycleRevision
    ) {
      throw new Error("Maintenance physical session receipt changed");
    }
    if (state.phase === "enrollment_pending") {
      state = transitionGatewayMaintenance(state, {
        action: "confirm",
        generation: input.generation,
        ownerInstanceId: input.ownerInstanceId,
        receipt: input.receipt,
      });
      writeConfigMachineStateInDatabase(database.db, gatewayMaintenanceStateKey, state);
    }
  }
  requestDevicePairingMutationAdmission({
    kind: "maintenance-enrollment",
    generation: input.generation,
    requestId: request.requestId,
    deviceId,
    agentId: request.agentId,
    sessionKey: request.sessionKey,
  });
  return {
    version: 1 as const,
    state,
    credential: { deviceId, publicKey: request.homePublicKey, role: "operator" as const, token },
    planned: enrollment.planned,
    ...(state.phase === "enrolled" ? { receipt: state.receipt } : {}),
  };
}
