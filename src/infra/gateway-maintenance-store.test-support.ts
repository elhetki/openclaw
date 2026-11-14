import assert from "node:assert/strict";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
  } finally {
    await closeStateDatabaseForTest();
  }
});
