import { readConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  gatewayMaintenanceStateKey,
  parseGatewayMaintenanceState,
  type GatewayMaintenanceCommand,
} from "./gateway-maintenance-state.js";
import type { gatewayMaintenanceOperations } from "./gateway-maintenance-state.worker.js";

/** Recovery commands recheck the exact current paired token inside the same transaction. */
export async function operateGatewayMaintenanceRecovery(
  input: Parameters<(typeof gatewayMaintenanceOperations)["gatewayMaintenance.recovery"]>[0],
  assertCurrent: () => void,
) {
  return runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext(),
    (scope) => scope.execute({ type: "gatewayMaintenance.recovery", input }),
    { assertCurrent },
  );
}

export async function readGatewayMaintenanceState(options: OpenClawStateDatabaseOptions = {}) {
  return parseGatewayMaintenanceState(
    await readConfigMachineStateAsync<unknown>(gatewayMaintenanceStateKey, options),
  );
}

export async function writeGatewayMaintenanceTransition(
  command: GatewayMaintenanceCommand,
  options: OpenClawStateDatabaseOptions = {},
  assertCurrent?: () => void,
) {
  return runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext(options),
    (scope) => scope.execute({ type: "gatewayMaintenance.transition", input: command }),
    { assertCurrent },
  );
}
