import {
  authorizeGatewayMaintenanceStateInDatabase,
  readGatewayMaintenanceInDatabase,
  readGatewayMaintenanceHomeCredentialInDatabase,
} from "./gateway-maintenance-authority.kernel.js";
import type { GatewayMaintenanceReleasedRequest } from "./gateway-maintenance-released-request.js";
import type { EngineConnection } from "./sql-connection.js";

export const gatewayMaintenanceReleasedReadOperations = {
  "gatewayMaintenance.releasedReceipt": (
    request: GatewayMaintenanceReleasedRequest,
    db: EngineConnection,
  ) => {
    const state = readGatewayMaintenanceInDatabase({ db });
    if (
      !state ||
      state.phase !== "released" ||
      !state.enrollment ||
      !state.receipt ||
      state.requestId !== request.requestId ||
      state.enrollment.requestId !== request.enrollmentRequestId ||
      state.binding.publicKey !== request.publicKey ||
      state.binding.agentId !== request.agentId ||
      state.binding.sessionKey !== request.sessionKey
    ) {
      throw new Error("Released maintenance receipt does not match the coordinator request");
    }
    authorizeGatewayMaintenanceStateInDatabase({ db }, state, {
      generation: request.generation,
      binding: state.binding,
      token: request.token,
    });
    readGatewayMaintenanceHomeCredentialInDatabase({ db }, state);
    return { type: "gatewayMaintenance.releasedReceipt" as const, state };
  },
};
