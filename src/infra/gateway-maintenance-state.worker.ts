import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state-row.js";
import { writeConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import {
  readAuthorizedGatewayMaintenanceInDatabase,
  readGatewayMaintenanceHomeCredentialInDatabase,
  type GatewayMaintenanceAuthority,
} from "./gateway-maintenance-authority.kernel.js";
import {
  gatewayMaintenanceStateKey,
  transitionGatewayMaintenance,
  type GatewayMaintenanceCommand,
} from "./gateway-maintenance-state.js";

export const gatewayMaintenanceOperations = {
  "gatewayMaintenance.recovery": (
    input: GatewayMaintenanceAuthority & {
      command?:
        | Extract<GatewayMaintenanceCommand, { action: "recover" | "recover-enrollment" }>
        | { action: "hold" | "release"; generation: number; ownerInstanceId: string };
    },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      ({ db }) => {
        const state = readAuthorizedGatewayMaintenanceInDatabase({ db }, input);
        if (!input.command) {
          return state;
        }
        if (
          !["draining", "held", "enrollment_pending", "enrolled"].includes(state.phase) ||
          !["recover", "recover-enrollment", "hold", "release"].includes(input.command.action) ||
          (["enrollment_pending", "enrolled"].includes(state.phase) && !state.enrollment) ||
          input.command.generation !== input.generation
        ) {
          throw new Error("Maintenance recovery command refused");
        }
        if (state.enrollment) {
          readGatewayMaintenanceHomeCredentialInDatabase({ db }, state);
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
