import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";

export const GatewayMaintenancePrepareParamsSchema = closedObject({
  requestId: Type.String({
    pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
  }),
  agentId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,127}$" }),
  sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
});
export const GatewayMaintenanceGenerationParamsSchema = closedObject({
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
export const GatewayMaintenanceEnrollmentParamsSchema = closedObject({
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  stage: Type.Union([Type.Literal("device"), Type.Literal("session")]),
  requestId: Type.String({
    pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
  }),
  homePublicKey: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  agentId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,127}$" }),
  sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
});
export type GatewayMaintenancePrepareParams = Static<typeof GatewayMaintenancePrepareParamsSchema>;
