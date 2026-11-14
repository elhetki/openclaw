import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { lazyCompile } from "../../packages/gateway-protocol/src/protocol-validator.js";
import { GatewayMaintenancePrepareParamsSchema } from "../../packages/gateway-protocol/src/schema/gateway-maintenance.js";
import { deriveDeviceIdFromPublicKey, verifyDeviceSignature } from "./device-identity.js";

const validateGatewayMaintenancePrepareParams = lazyCompile(GatewayMaintenancePrepareParamsSchema);

export type GatewayMaintenanceBootstrapRequest = {
  requestId: string;
  agentId: string;
  sessionKey: string;
  publicKey: string;
  signedAt: number;
  signature: string;
};

/** Root's private signing key never leaves the coordinator. Each offline retry
 * signs this exact request/target with a fresh timestamp and the same request ID. */
export function buildGatewayMaintenanceBootstrapPayload(
  request: Omit<GatewayMaintenanceBootstrapRequest, "signature">,
): string {
  return JSON.stringify([
    "openclaw-maintenance-bootstrap-v1",
    request.requestId,
    request.agentId,
    request.sessionKey,
    request.publicKey,
    request.signedAt,
  ]);
}

export function verifyGatewayMaintenanceBootstrapRequest(value: unknown): {
  request: GatewayMaintenanceBootstrapRequest;
  deviceId: string;
} {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    !validateGatewayMaintenancePrepareParams({
      requestId: value.requestId,
      agentId: value.agentId,
      sessionKey: value.sessionKey,
    }) ||
    typeof value.publicKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.publicKey) ||
    typeof value.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(value.signature) ||
    typeof value.signedAt !== "number" ||
    !Number.isSafeInteger(value.signedAt) ||
    Math.abs(Date.now() - value.signedAt) > 120_000
  ) {
    throw new Error("Invalid signed maintenance bootstrap request");
  }
  // The closed wire check above establishes these fields; no credential or authority is inferred.
  const request = value as GatewayMaintenanceBootstrapRequest;
  const deviceId = deriveDeviceIdFromPublicKey(request.publicKey);
  if (
    !deviceId ||
    !request.sessionKey.startsWith(`agent:${request.agentId}:`) ||
    /[\s\p{Cc}\p{Cf}]/u.test(request.sessionKey) ||
    !verifyDeviceSignature(
      request.publicKey,
      buildGatewayMaintenanceBootstrapPayload(request),
      request.signature,
    )
  ) {
    throw new Error("Maintenance bootstrap signing proof refused");
  }
  return { request, deviceId };
}
