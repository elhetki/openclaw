import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { lazyCompile } from "../../packages/gateway-protocol/src/protocol-validator.js";
import { GatewayMaintenancePrepareParamsSchema } from "../../packages/gateway-protocol/src/schema/gateway-maintenance.js";
import { deriveDeviceIdFromPublicKey, verifyDeviceSignature } from "./device-identity.js";

const validateTarget = lazyCompile(GatewayMaintenancePrepareParamsSchema);
export type GatewayMaintenanceReleasedRequest = {
  generation: number;
  requestId: string;
  enrollmentRequestId: string;
  agentId: string;
  sessionKey: string;
  publicKey: string;
  token: string;
  signedAt: number;
  signature: string;
};

export function buildGatewayMaintenanceReleasedPayload(
  request: Omit<GatewayMaintenanceReleasedRequest, "signature">,
) {
  return JSON.stringify([
    "openclaw-maintenance-released-receipt-v1",
    request.generation,
    request.requestId,
    request.enrollmentRequestId,
    request.agentId,
    request.sessionKey,
    request.publicKey,
    request.token,
    request.signedAt,
  ]);
}

export function verifyGatewayMaintenanceReleasedRequest(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 9 ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !validateTarget({
      requestId: value.requestId,
      agentId: value.agentId,
      sessionKey: value.sessionKey,
    }) ||
    !validateTarget({
      requestId: value.enrollmentRequestId,
      agentId: value.agentId,
      sessionKey: value.sessionKey,
    }) ||
    typeof value.publicKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.publicKey) ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    value.token.length > 1024 ||
    typeof value.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(value.signature) ||
    typeof value.signedAt !== "number" ||
    !Number.isSafeInteger(value.signedAt) ||
    Math.abs(Date.now() - value.signedAt) > 120_000
  ) {
    throw new Error("Invalid signed maintenance released-receipt request");
  }
  // Closed wire validation establishes shape, never persisted authority.
  const request = value as GatewayMaintenanceReleasedRequest;
  if (
    !deriveDeviceIdFromPublicKey(request.publicKey) ||
    !verifyDeviceSignature(
      request.publicKey,
      buildGatewayMaintenanceReleasedPayload(request),
      request.signature,
    )
  ) {
    throw new Error("Maintenance released-receipt signing proof refused");
  }
  return request;
}
