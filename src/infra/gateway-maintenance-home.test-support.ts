import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  publicKeyRawBase64UrlFromPem,
  deriveDeviceIdFromPublicKey,
  signDevicePayload,
} from "./device-identity.js";
import { rotateDeviceToken } from "./device-pairing-tokens.js";
import { executeDevicePairingMutation } from "./device-pairing-worker.js";
import { getPairedDevice } from "./device-pairing.js";
import { buildGatewayMaintenanceBootstrapPayload } from "./gateway-maintenance-bootstrap-request.js";
import {
  readGatewayMaintenanceState,
  operateGatewayMaintenanceRecovery,
} from "./gateway-maintenance-store.js";

await withOpenClawTestState({ label: "maintenance-home-pairing" }, async () => {
  const owner = generateKeyPairSync("ed25519");
  const request = {
    requestId: randomUUID(),
    agentId: "fixture",
    sessionKey: "agent:fixture:direct:home",
    publicKey: publicKeyRawBase64UrlFromPem(
      owner.publicKey.export({ type: "spki", format: "pem" }),
    ),
    signedAt: Date.now(),
  };
  const ownerInstanceId = randomUUID();
  const bootstrap = await executeDevicePairingMutation({
    type: "devicePairing.bootstrapMaintenance",
    input: {
      ownerInstanceId,
      request: {
        ...request,
        signature: signDevicePayload(
          owner.privateKey.export({ type: "pkcs8", format: "pem" }),
          buildGatewayMaintenanceBootstrapPayload(request),
        ),
      },
    },
  });
  const authority = {
    generation: bootstrap.state.generation,
    binding: bootstrap.state.binding,
    token: bootstrap.credential.token,
  };
  const held = await operateGatewayMaintenanceRecovery(
    {
      ...authority,
      command: { action: "hold", generation: authority.generation, ownerInstanceId },
    },
    () => {},
  );
  const homePublicKey = publicKeyRawBase64UrlFromPem(
    generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }),
  );
  const homeDeviceId = deriveDeviceIdFromPublicKey(homePublicKey)!;
  const enrollment = {
    requestId: randomUUID(),
    homePublicKey,
    agentId: request.agentId,
    sessionKey: request.sessionKey,
  };
  const input = { ...authority, ownerInstanceId, request: enrollment, action: "prepare" as const };
  const command = { type: "devicePairing.enrollMaintenanceHome" as const, input };
  try {
    let afterWrites = false;
    await assert.rejects(
      executeDevicePairingMutation(command, {
        admit(fact) {
          if (fact.kind === "maintenance-enrollment") {
            afterWrites = true;
            throw new Error("Synthetic Home pairing custody loss");
          }
        },
      }),
      /custody loss/,
    );
    assert.equal(afterWrites, true);
    assert.equal(await getPairedDevice(homeDeviceId), null);
    assert.deepEqual(await readGatewayMaintenanceState(), held);

    // Discard the committed response and reopen native state, then recover only
    // the same request/key/target. No new pairing or physical ID is generated.
    await executeDevicePairingMutation(command);
    await closeStateDatabaseForTest();
    const pending = await readGatewayMaintenanceState();
    assert.ok(pending?.enrollment);
    assert.equal(pending.phase, "enrollment_pending");
    const device = await getPairedDevice(homeDeviceId);
    const retry = await executeDevicePairingMutation(command);
    assert.deepEqual(retry.state, pending);
    assert.equal(retry.credential.token, device?.tokens?.operator?.token);
    assert.deepEqual(retry.planned, pending.enrollment.planned);
    assert.equal(retry.receipt, undefined);
    await assert.rejects(
      operateGatewayMaintenanceRecovery(
        {
          ...authority,
          command: { action: "release", generation: authority.generation, ownerInstanceId },
        },
        () => {},
      ),
    );
    for (const changed of [
      { ...enrollment, requestId: randomUUID() },
      { ...enrollment, homePublicKey: request.publicKey },
      { ...enrollment, sessionKey: `${request.sessionKey}:other` },
    ]) {
      await assert.rejects(
        executeDevicePairingMutation({ ...command, input: { ...input, request: changed } }),
      );
      assert.deepEqual(await readGatewayMaintenanceState(), pending);
    }
    await assert.rejects(
      executeDevicePairingMutation({
        ...command,
        input: {
          ...input,
          action: "confirm",
          receipt: { sessionId: randomUUID(), lifecycleRevision: randomUUID() },
        },
      }),
    );
    const newOwner = randomUUID();
    const recovered = await operateGatewayMaintenanceRecovery(
      {
        ...authority,
        command: {
          action: "recover-enrollment",
          generation: authority.generation,
          previousOwnerInstanceId: ownerInstanceId,
          ownerInstanceId: newOwner,
        },
      },
      () => {},
    );
    assert.equal(recovered.phase, "enrollment_pending");
    assert.deepEqual(recovered.enrollment, pending.enrollment);
    await assert.rejects(executeDevicePairingMutation(command));
    assert.deepEqual(
      (
        await executeDevicePairingMutation({
          ...command,
          input: { ...input, ownerInstanceId: newOwner, action: "read" },
        })
      ).planned,
      retry.planned,
    );
    await rotateDeviceToken({ deviceId: homeDeviceId, role: "operator" });
    await assert.rejects(
      executeDevicePairingMutation({
        ...command,
        input: { ...input, ownerInstanceId: newOwner, action: "read" },
      }),
      /receipt or credential changed/,
    );
  } finally {
    await closeStateDatabaseForTest();
  }
});
