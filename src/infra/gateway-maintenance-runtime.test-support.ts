import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createCoreGatewayMethodDescriptors } from "../gateway/methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import { maintenanceHandlers } from "../gateway/server-methods/maintenance.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
} from "../gateway/server-methods/types.js";
import {
  isGatewayWorkAdmissionClosed,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { deriveDeviceIdFromPublicKey } from "./device-identity.js";
import { readGatewayMaintenanceState } from "./gateway-maintenance-store.js";

function client(): GatewayClient {
  const publicKey = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64url");
  const deviceId = deriveDeviceIdFromPublicKey(publicKey)!;
  return {
    connId: randomUUID(),
    isDeviceTokenAuth: true,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.admin"],
      client: { id: "cli", version: "fixture", platform: "linux", mode: "cli" },
      device: { id: deviceId, publicKey, signature: "fixture", signedAt: 0, nonce: "fixture" },
    },
    internal: {
      authenticatedOperator: true,
      isLocalClient: true,
      operatorDeviceTokenIdentity: { deviceId, key: "c".repeat(64) },
    },
  };
}

await withOpenClawTestState({ label: "maintenance-runtime" }, async () => {
  let paused = false;
  const context = {
    getRuntimeConfig: () => ({}),
    logGateway: { warn() {}, info() {} },
    cron: {
      pauseScheduling() {
        paused = true;
      },
      resumeScheduling() {
        paused = false;
      },
      getSuspensionBlockerCount: () => 0,
    },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
  } as unknown as GatewayRequestContext;
  const coordinator = client();
  const foreign = client();
  let current = true;
  let ordinaryCalls = 0;
  const ordinary: GatewayRequestHandler = ({ respond }) => {
    ordinaryCalls++;
    respond(true, {});
  };
  const registry = createGatewayMethodRegistry(
    createCoreGatewayMethodDescriptors({
      ...maintenanceHandlers,
      "gateway.suspend.resume": ordinary,
      "sessions.create": ordinary,
    }),
  );
  const invoke = async (
    method: string,
    params: Record<string, unknown>,
    selected = coordinator,
    dispatch = true,
  ) => {
    let response: { ok: boolean; value?: unknown } | undefined;
    const options = {
      req: { type: "req" as const, id: randomUUID(), method, params },
      params,
      client: selected,
      context,
      methodRegistry: registry,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: () => current,
      respond: (ok: boolean, value?: unknown) => {
        response = { ok, value };
      },
    };
    if (dispatch) {
      await handleGatewayRequest(options);
    } else {
      await maintenanceHandlers[method]!(options);
    }
    assert.ok(response, "handler must produce a response");
    return response;
  };
  const request = {
    requestId: randomUUID(),
    agentId: "fixture",
    sessionKey: "agent:fixture:direct:enrollment",
  };
  let prior: ReturnType<typeof tryBeginGatewayRootWorkAdmission> = null;
  try {
    assert.equal(
      (
        await invoke(
          "gateway.maintenance.prepare",
          { ...request, deviceId: "wire-forged" },
          coordinator,
          false,
        )
      ).ok,
      false,
    );
    assert.equal(isGatewayWorkAdmissionClosed(), false);
    for (const rejected of [
      { ...coordinator, usesSharedGatewayAuth: true },
      { ...coordinator, isDeviceTokenAuth: false },
      { ...coordinator, internal: { ...coordinator.internal, isLocalClient: undefined } },
      { ...coordinator, internal: { ...coordinator.internal, syntheticClient: true as const } },
    ]) {
      assert.equal(
        (await invoke("gateway.maintenance.prepare", request, rejected, false)).ok,
        false,
      );
      assert.equal(isGatewayWorkAdmissionClosed(), false);
      assert.equal(await readGatewayMaintenanceState(), undefined);
    }
    prior = tryBeginGatewayRootWorkAdmission("accepted-before-maintenance");
    assert.ok(prior);
    assert.deepEqual(await invoke("gateway.maintenance.prepare", request), {
      ok: true,
      value: {
        generation: 1,
        phase: "draining",
        activeCount: 1,
        blockers: [
          {
            kind: "root-request",
            count: 1,
            message: "1 active gateway request(s): accepted-before-maintenance",
          },
        ],
        writeCustody: [],
      },
    });
    assert.equal(paused, true);
    assert.equal(isGatewayWorkAdmissionClosed(), true);
    assert.equal(tryBeginGatewayRootWorkAdmission("ordinary-session-create"), null);
    assert.equal((await invoke("gateway.suspend.resume", { suspensionId: "other" })).ok, false);
    assert.equal((await invoke("sessions.create", {})).ok, false);
    assert.equal(ordinaryCalls, 0);
    assert.equal(
      (await invoke("gateway.maintenance.status", { generation: 1 }, foreign)).ok,
      false,
    );
    assert.equal((await invoke("gateway.maintenance.status", { generation: 2 })).ok, false);
    const replacementToken = {
      ...coordinator,
      internal: {
        ...coordinator.internal,
        operatorDeviceTokenIdentity: {
          deviceId: coordinator.connect.device!.id,
          key: "d".repeat(64),
        },
      },
    };
    assert.equal(
      (await invoke("gateway.maintenance.status", { generation: 1 }, replacementToken)).ok,
      false,
    );
    assert.equal(
      (await invoke("gateway.maintenance.release", { generation: 1 }, replacementToken)).ok,
      false,
    );
    assert.equal((await invoke("gateway.maintenance.release", { generation: 1 })).ok, false);
    assert.equal((await readGatewayMaintenanceState())?.phase, "draining");
    prior.release();
    assert.equal((await invoke("gateway.maintenance.status", { generation: 1 })).ok, true);
    assert.equal((await readGatewayMaintenanceState())?.phase, "held");
    current = false;
    await assert.rejects(
      invoke("gateway.maintenance.release", { generation: 1 }),
      /authority changed/,
    );
    assert.equal(isGatewayWorkAdmissionClosed(), true);
    current = true;
    assert.equal((await invoke("gateway.maintenance.release", { generation: 1 })).ok, true);
    assert.equal(
      (
        await invoke("gateway.maintenance.prepare", {
          ...request,
          requestId: randomUUID(),
        })
      ).ok,
      true,
    );
    assert.equal((await readGatewayMaintenanceState())?.generation, 2);
    assert.equal((await invoke("gateway.maintenance.release", { generation: 1 })).ok, false);
    assert.equal(isGatewayWorkAdmissionClosed(), true);
    assert.equal((await invoke("gateway.maintenance.release", { generation: 2 })).ok, true);
    assert.equal(paused, false);
    assert.equal(isGatewayWorkAdmissionClosed(), false);
    assert.equal((await readGatewayMaintenanceState())?.phase, "released");
    assert.equal((await invoke("gateway.maintenance.release", { generation: 2 })).ok, true);
  } finally {
    prior?.release();
    await closeStateDatabaseForTest();
  }
});
