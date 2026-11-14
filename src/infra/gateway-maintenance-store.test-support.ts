import assert from "node:assert/strict";
import { prepareGatewayServerBootstrap } from "../gateway/server-startup-bootstrap.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { gatewayMaintenanceStateKey } from "./gateway-maintenance-state.js";
import {
  readGatewayMaintenanceState,
  writeGatewayMaintenanceTransition,
} from "./gateway-maintenance-store.js";

await withOpenClawTestState({ label: "gateway-maintenance" }, async (state) => {
  const options = { env: state.env };
  const ownerInstanceId = "00000000-0000-4000-8000-000000000001";
  try {
    assert.equal(await readGatewayMaintenanceState(options), undefined);
    const persisted = await writeGatewayMaintenanceTransition(
      {
        action: "begin",
        ownerInstanceId,
        requestId: "00000000-0000-4000-8000-000000000002",
        binding: {
          deviceId: "a".repeat(64),
          publicKey: "b".repeat(43),
          tokenIdentityKey: "c".repeat(64),
          agentId: "fixture",
          sessionKey: "agent:fixture:direct:fixture",
        },
      },
      options,
    );
    assert.deepEqual(await readGatewayMaintenanceState(options), persisted);
    await assert.rejects(
      writeGatewayMaintenanceTransition(
        { action: "hold", generation: 2, ownerInstanceId },
        options,
      ),
    );
    await assert.rejects(
      writeGatewayMaintenanceTransition(
        { action: "hold", generation: 1, ownerInstanceId },
        options,
        () => {
          throw new Error("revoked fixture authority");
        },
      ),
      /revoked/,
    );
    assert.equal((await readGatewayMaintenanceState(options))?.phase, "draining");
    await closeStateDatabaseForTest();
    assert.deepEqual(await readGatewayMaintenanceState(options), persisted);
    const logger = createSubsystemLogger("maintenance-test");
    const boot = () =>
      prepareGatewayServerBootstrap({
        port: 0,
        opts: {},
        log: logger,
        logSecrets: logger,
        loadWorkerEnvironmentStartupModule: async () => {
          throw new Error("maintenance must fence worker startup");
        },
        formatRuntimeGatewayAuthTokenWarning: () => "fixture",
      });
    await assert.rejects(
      boot(),
      /Gateway maintenance generation 1 requires explicit reconciliation before startup/,
    );
    await writeConfigMachineStateAsync(gatewayMaintenanceStateKey, { version: 2 }, options);
    await closeStateDatabaseForTest();
    await assert.rejects(boot(), /Gateway maintenance state could not be verified/);
  } finally {
    await closeStateDatabaseForTest();
  }
});
