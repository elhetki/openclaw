import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state-row.js";
import { writeConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import { isPairedDeviceTokenIdentityCurrent } from "./device-pairing-identity.js";
import { readPairedDevicePairingSnapshotFromDatabase } from "./device-pairing-store.js";
import {
  gatewayMaintenanceStateKey,
  transitionGatewayMaintenance,
  parseGatewayMaintenanceState,
  type GatewayMaintenanceBinding,
  type GatewayMaintenanceCommand,
} from "./gateway-maintenance-state.js";

export const gatewayMaintenanceOperations = {
  "gatewayMaintenance.recovery": (
    input: {
      generation: number;
      binding: GatewayMaintenanceBinding;
      sharedAuthGeneration?: string;
      command?:
        | Extract<GatewayMaintenanceCommand, { action: "recover" }>
        | { action: "hold" | "release"; generation: number; ownerInstanceId: string };
    },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      ({ db }) => {
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
        if (!input.command) {
          return state;
        }
        if (
          !["draining", "held"].includes(state.phase) ||
          !["recover", "hold", "release"].includes(input.command.action) ||
          input.command.generation !== input.generation
        ) {
          throw new Error("Maintenance recovery command refused");
        }
        const next = transitionGatewayMaintenance(state, input.command);
        writeConfigMachineStateInDatabase(db, gatewayMaintenanceStateKey, next);
        return next;
      },
      { operationLabel: "gateway-maintenance.recovery" },
    ),
  "gatewayMaintenance.transition": (
    input: GatewayMaintenanceCommand,
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      ({ db }) => {
        const row = readConfigMachineStateRowInDatabase(db, gatewayMaintenanceStateKey);
        const current: unknown = row ? JSON.parse(row.value_json) : undefined;
        const next = transitionGatewayMaintenance(current, input);
        writeConfigMachineStateInDatabase(db, gatewayMaintenanceStateKey, next);
        return next;
      },
      { operationLabel: "gateway-maintenance.transition" },
    ),
};
