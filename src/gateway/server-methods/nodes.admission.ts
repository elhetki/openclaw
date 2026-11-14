import {
  ErrorCodes,
  errorShape,
  validateNodeAdmissionDescribeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadDeviceIdentityIfPresent } from "../../infra/device-identity.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "../../infra/device-pairing-node-state.js";
import { resolveDispatchableNodeSession } from "./nodes.shared.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

// Only authenticated transport facts are accepted here. In-process tools may
// retain operator scopes, but cannot use them to read admission capabilities.
const transportFacts = new Set([
  "authenticatedOperator",
  "operatorDeviceTokenIdentity",
  "isLocalClient",
  "authenticatedControlUi",
  "controlUiAdmin",
  "operatorRoleActor",
  "operatorAccessAuthority",
  "remoteIngressPrincipal",
]);

function isAdmissionOperator(client: GatewayClient | null): boolean {
  const identity = client?.internal?.operatorDeviceTokenIdentity;
  return Boolean(
    client &&
    !client.invalidated &&
    client.connId &&
    client.connectionSignal &&
    !client.connectionSignal.aborted &&
    client.isDeviceTokenAuth === true &&
    client.connect.role === "operator" &&
    client.connect.scopes?.includes("operator.admin") &&
    client.internal?.authenticatedOperator === true &&
    identity?.deviceId === client.connect.device?.id &&
    identity?.key &&
    Object.keys(client.internal).every((key) => transportFacts.has(key)),
  );
}

export const nodeAdmissionHandlers: GatewayRequestHandlers = {
  "node.admission.describe": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateNodeAdmissionDescribeParams,
        "node.admission.describe",
        respond,
      )
    ) {
      return;
    }
    const deny = () =>
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "signed admin operator transport required"),
      );
    if (!isAdmissionOperator(client)) {
      deny();
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const gatewayDeviceId = loadDeviceIdentityIfPresent()?.deviceId;
      if (!gatewayDeviceId || gatewayDeviceId !== params.expectedGatewayDeviceId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Gateway installation mismatch"),
        );
        return;
      }
      const generation = await captureNodePairingGeneration(params.nodeId);
      const session =
        generation &&
        resolveDispatchableNodeSession(
          context.nodeRegistry.getForPairingGeneration(params.nodeId, generation.key),
        );
      const connectionId = session?.connId;
      if (
        !generation ||
        generation.nodeId !== params.nodeId ||
        !session ||
        !(await isNodePairingGenerationCurrent(generation))
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "node admission changed or unavailable"),
        );
        return;
      }
      if (!isAdmissionOperator(client)) {
        deny();
        return;
      }
      const current = resolveDispatchableNodeSession(
        context.nodeRegistry.getForPairingGeneration(params.nodeId, generation.key),
      );
      if (
        !current ||
        current.connId !== connectionId ||
        loadDeviceIdentityIfPresent()?.deviceId !== gatewayDeviceId
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "node admission changed or unavailable"),
        );
        return;
      }
      respond(
        true,
        {
          gatewayDeviceId,
          expectedPairing: {
            deviceId: generation.nodeId,
            generation: generation.key,
            connectionId: current.connId,
          },
        },
        undefined,
      );
    });
  },
};
