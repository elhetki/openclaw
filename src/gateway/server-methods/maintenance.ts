import {
  ErrorCodes,
  errorShape,
  validateGatewayMaintenancePrepareParams as validatePrepare,
  validateGatewayMaintenanceGenerationParams as validateGeneration,
} from "../../../packages/gateway-protocol/src/index.js";
import { deriveDeviceIdFromPublicKey } from "../../infra/device-identity.js";
import { createGatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import {
  transitionGatewayMaintenance,
  type GatewayMaintenanceState,
} from "../../infra/gateway-maintenance-state.js";
import {
  readGatewayMaintenanceState,
  writeGatewayMaintenanceTransition,
} from "../../infra/gateway-maintenance-store.js";
import {
  holdGatewayMaintenanceAdmission,
  isGatewayWorkAdmissionClosed,
} from "../../process/gateway-work-admission.js";
import { bindGatewayDeviceRevocation } from "../device-revocation.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { createGatewayServerActiveWorkInspectors } from "../server-active-work.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "./types.js";

type Owner = {
  busy: boolean;
  uncertain: boolean;
  state?: GatewayMaintenanceState;
  hold?: ReturnType<typeof holdGatewayMaintenanceAdmission>;
};
const owners = new WeakMap<GatewayRequestContext, Owner>();

function refuse(): never {
  throw new Error("Gateway maintenance authority or state requires reconciliation");
}

/** Only the authenticated local device may control its generation. Wire params
 * never provide a device, token, live-authority callback, or process identity. */
function caller(options: Parameters<GatewayRequestHandler>[0]) {
  const { client, hasCurrentClientAuthority, signal } = options;
  const device = client?.connect.device;
  const tokenIdentity = client?.internal?.operatorDeviceTokenIdentity;
  if (
    !client?.isDeviceTokenAuth ||
    client.usesSharedGatewayAuth !== false ||
    client.internal?.authenticatedOperator !== true ||
    client.internal.isLocalClient !== true ||
    !client.connId ||
    client.invalidated ||
    client.connectionSignal?.aborted ||
    client.internal.syntheticClient ||
    client.internal.agentToolCaller ||
    client.internal.agentRuntimeIdentity ||
    client.internal.pluginRuntimeOwnerId ||
    client.connect.role !== "operator" ||
    !client.connect.scopes?.includes("operator.admin") ||
    !device ||
    !tokenIdentity ||
    tokenIdentity.deviceId !== device.id ||
    !tokenIdentity.key ||
    deriveDeviceIdFromPublicKey(device.publicKey) !== device.id ||
    !hasCurrentClientAuthority
  ) {
    return refuse();
  }
  const tokenIdentityKey = tokenIdentity.key;
  const deviceId = device.id;
  const publicKey = device.publicKey;
  const assertCurrent = bindGatewayDeviceRevocation(() => {
    signal?.throwIfAborted();
    if (
      !hasCurrentClientAuthority() ||
      client.internal?.operatorDeviceTokenIdentity?.key !== tokenIdentityKey ||
      client.internal.operatorDeviceTokenIdentity.deviceId !== deviceId ||
      client.connect.device?.id !== deviceId ||
      client.connect.device.publicKey !== publicKey
    ) {
      refuse();
    }
  }, hasCurrentClientAuthority);
  assertCurrent();
  return { deviceId, publicKey, tokenIdentityKey, assertCurrent };
}

function handler(action: "prepare" | "status" | "release"): GatewayRequestHandler {
  return async (options) => {
    const { params, context, respond } = options;
    let owner: Owner | undefined;
    let acquired = false;
    try {
      const identity = caller(options);
      const prepare = action === "prepare" && validatePrepare(params) ? params : undefined;
      const selected = action !== "prepare" && validateGeneration(params) ? params : undefined;
      if (!prepare && !selected) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Invalid maintenance params"),
        );
        return;
      }
      owner = owners.get(context);
      if (owner?.busy || owner?.uncertain) {
        refuse();
      }
      if (prepare && owner?.state?.phase === "released" && !owner.hold) {
        if (prepare.requestId === owner.state.requestId) {
          refuse();
        }
        owners.delete(context);
        owner = undefined;
      }
      if (!owner) {
        // A rootless status/release cannot initialize, recover or adopt a generation.
        if (!prepare || isGatewayWorkAdmissionClosed()) {
          refuse();
        }
        owner = { busy: false, uncertain: false };
        owners.set(context, owner);
      }
      owner.busy = true;
      acquired = true;
      const selectedOwner = owner;
      const assertCurrent = bindGatewayDeviceRevocation(() => {
        identity.assertCurrent();
        selectedOwner.hold?.assertCurrent();
        if (selectedOwner.uncertain) {
          refuse();
        }
      }, options.hasCurrentClientAuthority);
      const persist: typeof writeGatewayMaintenanceTransition = async (
        command,
        databaseOptions,
        guard,
      ) => {
        try {
          return await writeGatewayMaintenanceTransition(command, databaseOptions, guard);
        } catch (error) {
          selectedOwner.uncertain = true;
          throw error;
        }
      };

      if (!owner.state) {
        if (!prepare) {
          refuse();
        }
        const command = {
          action: "begin" as const,
          requestId: prepare.requestId,
          ownerInstanceId: getGatewayProcessInstanceId(),
          binding: {
            deviceId: identity.deviceId,
            publicKey: identity.publicKey,
            tokenIdentityKey: identity.tokenIdentityKey,
            agentId: prepare.agentId,
            sessionKey: prepare.sessionKey,
          },
        };
        // Validate target syntax before closing admission or touching persistence.
        transitionGatewayMaintenance(undefined, command);
        owner.hold = holdGatewayMaintenanceAdmission();
        try {
          context.cron.pauseScheduling();
          const existing = await readGatewayMaintenanceState();
          assertCurrent();
          if (existing && existing.phase !== "released") {
            refuse();
          }
          owner.state = await persist(command, {}, assertCurrent);
        } catch (error) {
          // Even a lost begin acknowledgement cannot reopen admission in this process.
          owner.uncertain = true;
          throw error;
        }
      }
      const state = owner.state;
      if (
        state.binding.deviceId !== identity.deviceId ||
        state.binding.publicKey !== identity.publicKey ||
        state.binding.tokenIdentityKey !== identity.tokenIdentityKey ||
        state.ownerInstanceId !== getGatewayProcessInstanceId() ||
        (selected && selected.generation !== state.generation) ||
        (prepare &&
          (prepare.requestId !== state.requestId ||
            prepare.agentId !== state.binding.agentId ||
            prepare.sessionKey !== state.binding.sessionKey))
      ) {
        refuse();
      }
      assertCurrent();
      if (state.phase === "released") {
        if (action !== "release") {
          refuse();
        }
        respond(true, { generation: state.generation, phase: "released" });
        return;
      }
      if (state.phase !== "draining" && state.phase !== "held") {
        refuse();
      }
      const inspect = () =>
        createGatewayActiveWorkSnapshot(createGatewayServerActiveWorkInspectors(context));
      const assertIdle = bindGatewayDeviceRevocation(() => {
        assertCurrent();
        if (!inspect().idle) {
          refuse();
        }
      }, options.hasCurrentClientAuthority);
      const snapshot = inspect();
      if (snapshot.idle && state.phase === "draining") {
        owner.state = await persist(
          {
            action: "hold",
            generation: state.generation,
            ownerInstanceId: state.ownerInstanceId,
          },
          {},
          assertIdle,
        );
      }
      if (action === "release") {
        if (owner.state.phase !== "held") {
          refuse();
        }
        owner.state = await persist(
          {
            action: "release",
            generation: state.generation,
            ownerInstanceId: state.ownerInstanceId,
          },
          {},
          assertIdle,
        );
        // Persist intent before reopening; if scheduler recovery fails, keep the
        // in-process hold. Ordinary restart may then perform normal startup.
        assertCurrent();
        try {
          context.cron.resumeScheduling();
        } catch (error) {
          owner.uncertain = true;
          throw error;
        }
        owner.hold!.release();
        owner.hold = undefined;
      }
      identity.assertCurrent();
      respond(true, {
        generation: owner.state.generation,
        phase: owner.state.phase,
        activeCount: snapshot.counts.totalActive,
        blockers: snapshot.blockers,
        writeCustody: snapshot.writeCustody,
      });
    } catch {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Gateway maintenance refused; preserve the current generation and reconcile its state",
        ),
      );
    } finally {
      if (owner && acquired) {
        owner.busy = false;
      }
    }
  };
}

export const maintenanceHandlers: GatewayRequestHandlers = {
  "gateway.maintenance.prepare": handler("prepare"),
  "gateway.maintenance.status": handler("status"),
  "gateway.maintenance.release": handler("release"),
};
