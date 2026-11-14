import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state-row.js";
import { writeConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import {
  gatewayMaintenanceStateKey,
  transitionGatewayMaintenance,
  type GatewayMaintenanceCommand,
} from "./gateway-maintenance-state.js";

export const gatewayMaintenanceOperations = {
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
