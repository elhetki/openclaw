import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state-row.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import {
  isPairedDeviceTokenIdentityCurrent,
  resolveAuthenticatedDeviceTokenIdentity,
} from "./device-pairing-identity.js";
import { readPairedDevicePairingSnapshotFromDatabase } from "./device-pairing-store.js";
import {
  gatewayMaintenanceStateKey,
  parseGatewayMaintenanceState,
  type GatewayMaintenanceBinding,
  type GatewayMaintenanceState,
} from "./gateway-maintenance-state.js";
import { verifyPairingToken } from "./pairing-token.js";

export type GatewayMaintenanceAuthority = {
  generation: number;
  binding: GatewayMaintenanceBinding;
  token: string;
  sharedAuthGeneration?: string;
};

/** The caller holds the shared-state transaction; signature admission belongs to
 * the cold transport, while current persisted credential authority belongs here. */
export function readAuthorizedGatewayMaintenanceInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  input: GatewayMaintenanceAuthority,
) {
  const { db } = database;
  const row = readConfigMachineStateRowInDatabase(db, gatewayMaintenanceStateKey);
  const state = parseGatewayMaintenanceState(row ? JSON.parse(row.value_json) : undefined);
  const binding = input.binding;
  const device =
    readPairedDevicePairingSnapshotFromDatabase(db, binding.deviceId).pairedByDeviceId[
      binding.deviceId
    ] ?? null;
  if (
    !state ||
    state.generation !== input.generation ||
    state.binding.deviceId !== binding.deviceId ||
    state.binding.publicKey !== binding.publicKey ||
    state.binding.tokenIdentityKey !== binding.tokenIdentityKey ||
    state.binding.agentId !== binding.agentId ||
    state.binding.sessionKey !== binding.sessionKey ||
    device?.publicKey !== binding.publicKey ||
    !verifyPairingToken(input.token, device.tokens?.operator?.token ?? "") ||
    !isPairedDeviceTokenIdentityCurrent(
      device,
      "operator",
      { deviceId: binding.deviceId, key: binding.tokenIdentityKey },
      ["operator.admin"],
    ) ||
    (device.tokens?.operator?.issuer &&
      device.tokens.operator.issuer.generation !== input.sharedAuthGeneration)
  ) {
    throw new Error("Maintenance coordinator authority changed");
  }
  return state;
}

export function readGatewayMaintenanceHomeCredentialInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  state: GatewayMaintenanceState,
) {
  const enrollment = state.enrollment;
  if (!enrollment) {
    throw new Error("Maintenance Home enrollment receipt missing");
  }
  const device = readPairedDevicePairingSnapshotFromDatabase(database.db, enrollment.deviceId)
    .pairedByDeviceId[enrollment.deviceId];
  const token = device?.tokens?.operator?.token;
  const identity = token
    ? resolveAuthenticatedDeviceTokenIdentity(device ?? null, {
        role: "operator",
        publicKey: enrollment.publicKey,
        token,
        scopes: ["operator.admin"],
      })
    : null;
  if (
    !token ||
    !identity ||
    identity.key !== enrollment.tokenIdentityKey ||
    device?.tokens?.operator?.issuer
  ) {
    throw new Error("Maintenance Home credential changed");
  }
  return {
    deviceId: enrollment.deviceId,
    publicKey: enrollment.publicKey,
    role: "operator" as const,
    token,
  };
}
