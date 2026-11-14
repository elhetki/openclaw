import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { deriveDeviceIdFromPublicKey } from "../infra/device-identity.js";
import type { GatewayMaintenanceBinding } from "../infra/gateway-maintenance-state.js";
import { resolveDeviceSignaturePayloadVersion } from "./server/ws-connection/handshake-auth-helpers.js";

/** Validated connect params still need possession of the exact durable owner's
 * signing key. Token possession/current approval is checked by the state worker
 * in the same transaction as each maintenance operation, including connect. */
export function verifyMaintenanceCoordinatorProof(
  connect: ConnectParams,
  binding: GatewayMaintenanceBinding,
  nonce: string,
): string {
  const device = connect.device;
  const token = connect.auth?.deviceToken;
  if (
    connect.minProtocol > PROTOCOL_VERSION ||
    connect.maxProtocol < PROTOCOL_VERSION ||
    connect.client.id !== "cli" ||
    connect.client.mode !== "cli" ||
    connect.role !== "operator" ||
    connect.scopes?.length !== 1 ||
    connect.scopes[0] !== "operator.admin" ||
    !token ||
    Object.keys(connect.auth ?? {}).some((key) => key !== "deviceToken") ||
    !device ||
    device.id !== binding.deviceId ||
    device.publicKey !== binding.publicKey ||
    deriveDeviceIdFromPublicKey(device.publicKey) !== device.id ||
    device.nonce !== nonce ||
    Math.abs(Date.now() - device.signedAt) > 120_000 ||
    resolveDeviceSignaturePayloadVersion({
      device,
      connectParams: connect,
      role: "operator",
      scopes: ["operator.admin"],
      signedAtMs: device.signedAt,
      nonce,
    }) !== "v3"
  ) {
    throw new Error("Maintenance coordinator authentication refused");
  }
  return token;
}
