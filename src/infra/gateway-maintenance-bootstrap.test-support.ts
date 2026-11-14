import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { bootstrapGatewayMaintenanceOffline } from "../gateway/maintenance-bootstrap.js";
import { tryBeginGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "./device-identity.js";
import { rotateDeviceToken } from "./device-pairing-tokens.js";
import { executeDevicePairingMutation } from "./device-pairing-worker.js";
import { getPairedDevice, listDevicePairing } from "./device-pairing.js";
import { buildGatewayMaintenanceBootstrapPayload } from "./gateway-maintenance-bootstrap-request.js";
import {
  readGatewayMaintenanceState,
  writeGatewayMaintenanceTransition,
} from "./gateway-maintenance-store.js";

function signer() {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = publicKeyRawBase64UrlFromPem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  return {
    deviceId: deriveDeviceIdFromPublicKey(publicKey)!,
    request(changes: { requestId?: string; agentId?: string; sessionKey?: string } = {}) {
      const value = {
        requestId: randomUUID(),
        agentId: "fixture",
        sessionKey: "agent:fixture:direct:bootstrap",
        publicKey,
        signedAt: Date.now(),
        ...changes,
      };
      return {
        ...value,
        signature: signDevicePayload(privateKey, buildGatewayMaintenanceBootstrapPayload(value)),
      };
    },
  };
}

await withOpenClawTestState({ label: "maintenance-bootstrap-atomic" }, async () => {
  const owner = signer();
  const request = owner.request();
  const command = {
    type: "devicePairing.bootstrapMaintenance" as const,
    input: { request, ownerInstanceId: randomUUID() },
  };
  let reachedCommit = false;
  try {
    await assert.rejects(
      executeDevicePairingMutation(command, {
        admit(fact) {
          if (fact.kind === "maintenance-bootstrap") {
            reachedCommit = true;
            throw new Error("Synthetic custody loss after pairing and intent writes");
          }
        },
      }),
      /custody loss/,
    );
    assert.equal(reachedCommit, true);
    assert.equal(await readGatewayMaintenanceState(), undefined);
    assert.equal(await getPairedDevice(owner.deviceId), null);
    assert.equal(
      (await listDevicePairing()).pending.some((entry) => entry.deviceId === owner.deviceId),
      false,
    );

    // The host loses the first acknowledgment after COMMIT. Reopen all native
    // state, then reconcile using the same signed request identity, not a new key.
    await executeDevicePairingMutation(command);
    await closeStateDatabaseForTest();
    const committed = await readGatewayMaintenanceState();
    const device = await getPairedDevice(owner.deviceId);
    assert.ok(committed);
    assert.ok(device?.tokens?.operator);
    const retry = await executeDevicePairingMutation({
      ...command,
      input: {
        request: owner.request({ requestId: request.requestId }),
        ownerInstanceId: randomUUID(),
      },
    });
    assert.deepEqual(retry.state, committed);
    assert.equal(retry.credential.token, device.tokens.operator.token);
    for (const changed of [
      owner.request(),
      owner.request({ requestId: request.requestId, sessionKey: "agent:fixture:other" }),
      owner.request({
        requestId: request.requestId,
        agentId: "other",
        sessionKey: "agent:other:direct:bootstrap",
      }),
      signer().request({ requestId: request.requestId }),
      { ...request, signature: "a".repeat(86) },
    ]) {
      await assert.rejects(
        executeDevicePairingMutation({ ...command, input: { ...command.input, request: changed } }),
      );
      assert.deepEqual(await readGatewayMaintenanceState(), committed);
    }
    await rotateDeviceToken({ deviceId: owner.deviceId, role: "operator" });
    await assert.rejects(executeDevicePairingMutation(command), /exact request and credential/);
    assert.deepEqual(await readGatewayMaintenanceState(), committed);
    await writeGatewayMaintenanceTransition({
      action: "hold",
      generation: committed.generation,
      ownerInstanceId: committed.ownerInstanceId,
    });
    const released = await writeGatewayMaintenanceTransition({
      action: "release",
      generation: committed.generation,
      ownerInstanceId: committed.ownerInstanceId,
    });
    const successor = signer();
    await assert.rejects(
      executeDevicePairingMutation({
        ...command,
        input: { request: successor.request(), ownerInstanceId: randomUUID() },
      }),
      /exact request and credential/,
    );
    assert.equal(
      await getPairedDevice(successor.deviceId),
      null,
      "First-install bootstrap must not reissue a coordinator after release",
    );
    assert.deepEqual(await readGatewayMaintenanceState(), released);
  } finally {
    await closeStateDatabaseForTest();
  }
});

await withOpenClawTestState({ label: "maintenance-bootstrap-offline" }, async (fixture) => {
  await fixture.writeConfig({
    gateway: { mode: "local", bind: "loopback" },
    agents: { entries: { fixture: { workspace: fixture.workspaceDir } } },
    plugins: { enabled: false },
  });
  const owner = signer();
  try {
    const receipt = await bootstrapGatewayMaintenanceOffline(owner.request());
    assert.equal(receipt.version, 1);
    assert.equal(receipt.state.phase, "draining");
    assert.equal(receipt.state.binding.deviceId, owner.deviceId);
    assert.equal(receipt.credential.role, "operator");
    assert.equal(
      tryBeginGatewayRootWorkAdmission(),
      null,
      "Offline one-shot never starts ordinary writers",
    );
    assert.deepEqual(await readGatewayMaintenanceState(), receipt.state);
  } finally {
    await closeStateDatabaseForTest();
  }
});
