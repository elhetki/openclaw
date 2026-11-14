import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** An explicit separate control policy, not a claim that ordinary access is unrestricted. */
export type PluginGatewayMaintenance = { policy: "core-coordinator-v1" };

export function parsePluginGatewayMaintenance(
  value: unknown,
): PluginGatewayMaintenance | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    value.policy !== "core-coordinator-v1"
  ) {
    throw new Error("gatewayMaintenance must contain only policy: core-coordinator-v1");
  }
  return { policy: "core-coordinator-v1" };
}

/** A policy version authorizes only this closed surface; adding methods requires a new version. */
export const GATEWAY_MAINTENANCE_COORDINATOR_METHODS = Object.freeze([
  "gateway.maintenance.status",
  "gateway.maintenance.recover",
  "gateway.maintenance.enroll",
  "gateway.maintenance.release",
] as const);
