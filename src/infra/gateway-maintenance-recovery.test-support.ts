import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "./device-pairing-identity.js";
import {
  ensureDeviceToken,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./device-pairing-tokens.js";
import {
  getPairedDevice,
  requestDevicePairing,
  withPairedDeviceRecords,
} from "./device-pairing.js";
import {
  operateGatewayMaintenanceRecovery,
  readGatewayMaintenanceState,
  writeGatewayMaintenanceTransition,
} from "./gateway-maintenance-store.js";

await withOpenClawTestState({ label: "gateway-maintenance-recovery" }, async () => {
  const deviceId = "a".repeat(64);
  const publicKey = "b".repeat(43);
  const scopes = ["operator.admin"];
  const assertCurrent = () => {};
  try {
    const { request } = await requestDevicePairing({
      deviceId,
      publicKey,
      role: "operator",
      scopes,
    });
    assert.equal(
      (await approveDevicePairing(request.requestId, { callerScopes: scopes }))?.status,
      "approved",
    );
    const device = await getPairedDevice(deviceId);
    const identity = resolveAuthenticatedDeviceTokenIdentity(device, {
      role: "operator",
      publicKey,
      token: device!.tokens!.operator!.token,
      scopes,
    });
    assert.ok(identity);
    const binding = {
      deviceId,
      publicKey,
      tokenIdentityKey: identity.key,
      agentId: "fixture",
      sessionKey: "agent:fixture:direct:recovery",
    };
    const oldOwner = randomUUID();
    const ownerInstanceId = randomUUID();
    const original = await writeGatewayMaintenanceTransition({
      action: "begin",
      requestId: randomUUID(),
      ownerInstanceId: oldOwner,
      binding,
    });
    await closeStateDatabaseForTest();
    const input = {
      generation: original.generation,
      binding,
      token: device!.tokens!.operator!.token,
    };
    assert.deepEqual(await operateGatewayMaintenanceRecovery(input, assertCurrent), original);
    for (const changed of [
      { token: "wrong-coordinator-token" },
      { generation: 2 },
      { binding: { ...binding, deviceId: "c".repeat(64) } },
      { binding: { ...binding, publicKey: "c".repeat(43) } },
      { binding: { ...binding, tokenIdentityKey: "c".repeat(64) } },
      { binding: { ...binding, sessionKey: "agent:fixture:other" } },
      { binding: { ...binding, agentId: "other" } },
    ]) {
      await assert.rejects(
        operateGatewayMaintenanceRecovery({ ...input, ...changed }, assertCurrent),
        /authority changed/,
      );
    }
    const command = {
      action: "recover" as const,
      generation: 1,
      ownerInstanceId,
      previousOwnerInstanceId: oldOwner,
    };
    await assert.rejects(
      operateGatewayMaintenanceRecovery({ ...input, command }, () => {
        throw new Error("transport closed");
      }),
      /transport closed/,
    );
    assert.deepEqual(await readGatewayMaintenanceState(), original);
    assert.equal(
      (await operateGatewayMaintenanceRecovery({ ...input, command }, assertCurrent))
        .ownerInstanceId,
      ownerInstanceId,
    );
    await assert.rejects(
      operateGatewayMaintenanceRecovery({ ...input, command }, assertCurrent),
      /reconciliation/,
    );
    await operateGatewayMaintenanceRecovery(
      { ...input, command: { action: "hold", generation: 1, ownerInstanceId } },
      assertCurrent,
    );
    await closeStateDatabaseForTest();
    assert.equal((await operateGatewayMaintenanceRecovery(input, assertCurrent)).phase, "held");
    assert.equal(
      (
        await operateGatewayMaintenanceRecovery(
          { ...input, command: { action: "release", generation: 1, ownerInstanceId } },
          assertCurrent,
        )
      ).phase,
      "released",
    );
    assert.equal((await operateGatewayMaintenanceRecovery(input, assertCurrent)).phase, "released");
    await writeGatewayMaintenanceTransition({
      action: "begin",
      requestId: randomUUID(),
      ownerInstanceId,
      binding,
    });
    input.generation = 2;
    await writeGatewayMaintenanceTransition({ action: "hold", generation: 2, ownerInstanceId });
    await writeGatewayMaintenanceTransition({ action: "enroll", generation: 2, ownerInstanceId });
    for (const phase of ["enrollment_pending", "enrolled"]) {
      assert.equal((await operateGatewayMaintenanceRecovery(input, assertCurrent)).phase, phase);
      for (const action of ["release", "hold"] as const) {
        await assert.rejects(
          operateGatewayMaintenanceRecovery(
            { ...input, command: { action, generation: 2, ownerInstanceId } },
            assertCurrent,
          ),
          /command refused/,
        );
      }
      await assert.rejects(
        operateGatewayMaintenanceRecovery(
          {
            ...input,
            command: {
              action: "recover",
              generation: 2,
              ownerInstanceId: randomUUID(),
              previousOwnerInstanceId: ownerInstanceId,
            },
          },
          assertCurrent,
        ),
        /command refused/,
      );
      if (phase === "enrollment_pending") {
        await writeGatewayMaintenanceTransition({
          action: "confirm",
          generation: 2,
          ownerInstanceId,
          receipt: { sessionId: randomUUID(), lifecycleRevision: randomUUID() },
        });
      }
    }
    // Only the still-internal enrollment owner can reconcile/release this receipt.
    await writeGatewayMaintenanceTransition({ action: "release", generation: 2, ownerInstanceId });
    await writeGatewayMaintenanceTransition({
      action: "begin",
      requestId: randomUUID(),
      ownerInstanceId,
      binding,
    });
    input.generation = 3;
    await writeGatewayMaintenanceTransition({ action: "hold", generation: 3, ownerInstanceId });
    assert.equal((await rotateDeviceToken({ deviceId, role: "operator" })).ok, true);
    await assert.rejects(
      operateGatewayMaintenanceRecovery(input, assertCurrent),
      /authority changed/,
    );
    await assert.rejects(
      operateGatewayMaintenanceRecovery(
        { ...input, command: { action: "release", generation: input.generation, ownerInstanceId } },
        assertCurrent,
      ),
      /authority changed/,
    );
    assert.equal((await readGatewayMaintenanceState())?.phase, "held");
    const replacement = await getPairedDevice(deviceId);
    const replacementIdentity = resolveAuthenticatedDeviceTokenIdentity(replacement, {
      role: "operator",
      publicKey,
      token: replacement!.tokens!.operator!.token,
      scopes,
    });
    assert.ok(replacementIdentity);
    await assert.rejects(
      operateGatewayMaintenanceRecovery(
        { ...input, binding: { ...binding, tokenIdentityKey: replacementIdentity.key } },
        assertCurrent,
      ),
      /authority changed/,
    );
    assert.equal((await revokeDeviceToken({ deviceId, role: "operator" })).ok, true);
    await assert.rejects(
      operateGatewayMaintenanceRecovery(input, assertCurrent),
      /authority changed/,
    );
    assert.equal((await readGatewayMaintenanceState())?.phase, "held");
    await writeGatewayMaintenanceTransition({ action: "release", generation: 3, ownerInstanceId });
    const issued = await ensureDeviceToken({
      deviceId,
      role: "operator",
      scopes,
      issuer: { kind: "shared-gateway-auth", generation: "fixture-auth-generation" },
    });
    assert.ok(issued);
    const issuedDevice = await getPairedDevice(deviceId);
    const issuedIdentity = resolveAuthenticatedDeviceTokenIdentity(issuedDevice, {
      role: "operator",
      publicKey,
      token: issued.token,
      scopes,
    });
    assert.ok(issuedIdentity);
    const issuedBinding = { ...binding, tokenIdentityKey: issuedIdentity.key };
    await writeGatewayMaintenanceTransition({
      action: "begin",
      requestId: randomUUID(),
      ownerInstanceId,
      binding: issuedBinding,
    });
    const issuedInput = { generation: 4, binding: issuedBinding, token: issued.token };
    await assert.rejects(
      operateGatewayMaintenanceRecovery(issuedInput, assertCurrent),
      /authority changed/,
    );
    await assert.rejects(
      operateGatewayMaintenanceRecovery(
        { ...issuedInput, sharedAuthGeneration: "stale-fixture-generation" },
        assertCurrent,
      ),
      /authority changed/,
    );
    const currentInput = { ...issuedInput, sharedAuthGeneration: "fixture-auth-generation" };
    assert.equal(
      (await operateGatewayMaintenanceRecovery(currentInput, assertCurrent)).phase,
      "draining",
    );
    await withPairedDeviceRecords(undefined, (devices) => {
      devices[deviceId]!.approvedScopes = ["operator.read"];
      return { value: undefined, persist: true };
    });
    await assert.rejects(
      operateGatewayMaintenanceRecovery(currentInput, assertCurrent),
      /authority changed/,
    );
    assert.equal((await readGatewayMaintenanceState())?.phase, "draining");
  } finally {
    await closeStateDatabaseForTest();
  }
});
