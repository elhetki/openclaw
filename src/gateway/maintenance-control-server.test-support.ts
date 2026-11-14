import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket } from "ws";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../config/io.js";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../infra/device-pairing-identity.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import {
  readGatewayMaintenanceState,
  writeGatewayMaintenanceTransition,
} from "../infra/gateway-maintenance-store.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { rawDataToString } from "../infra/ws.js";
import { tryBeginGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { assertOrdinaryGatewayMaintenanceReleased } from "./maintenance-startup.js";
import { startGatewayServer } from "./server.js";

function record(value: unknown) {
  assert.ok(isRecord(value));
  return value;
}

function peer(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  const queued: unknown[] = [];
  let deliver: ((value: unknown) => void) | undefined;
  socket.on("message", (bytes) => {
    const value: unknown = JSON.parse(rawDataToString(bytes));
    if (deliver) {
      const selected = deliver;
      deliver = undefined;
      selected(value);
    } else {
      queued.push(value);
    }
  });
  const next = async () =>
    record(
      queued.length
        ? queued.shift()
        : await new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Maintenance reply timed out")),
              10_000,
            );
            deliver = (value) => {
              clearTimeout(timeout);
              resolve(value);
            };
          }),
    );
  return {
    socket,
    next,
    async call(method: string, params: unknown) {
      const id = randomUUID();
      socket.send(JSON.stringify({ type: "req", id, method, params }));
      const result = await next();
      assert.equal(result.id, id);
      return result;
    },
  };
}

await withOpenClawTestState({ label: "maintenance-public-control" }, async (fixture) => {
  const mode = process.argv[2] ?? "public";
  const cold = mode === "cold";
  const runtimeMarker = fixture.path("plugin-ran");
  await fixture.writeJson("plugin/openclaw.plugin.json", {
    id: "maintenance-fixture",
    ...(mode === "reject-plugin" ? {} : { gatewayMaintenance: { policy: "core-coordinator-v1" } }),
    configSchema: { type: "object", additionalProperties: false },
  });
  await fixture.writeJson("plugin/package.json", {
    name: "maintenance-fixture",
    version: "1.0.0",
    openclaw: { extensions: ["./index.cjs"] },
  });
  await fixture.writeText(
    "plugin/index.cjs",
    `require('node:fs').writeFileSync(${JSON.stringify(runtimeMarker)}, 'forbidden'); throw new Error('Normal plugin runtime must not load');`,
  );
  const config = {
    gateway: { bind: mode === "reject-config" ? "lan" : "loopback", mode: "local" },
    agents: { entries: { fixture: { workspace: fixture.workspaceDir } } },
    plugins: {
      allow: ["maintenance-fixture"],
      load: { paths: [fixture.statePath("plugin")] },
      entries: { "maintenance-fixture": { enabled: true } },
      slots: { memory: "none" },
    },
  };
  await fixture.writeConfig(config);
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = publicKeyRawBase64UrlFromPem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const deviceId = deriveDeviceIdFromPublicKey(publicKey)!;
  const scopes = ["operator.admin"];
  const { request } = await requestDevicePairing({ deviceId, publicKey, role: "operator", scopes });
  assert.equal(
    (await approveDevicePairing(request.requestId, { callerScopes: scopes }))?.status,
    "approved",
  );
  const device = await getPairedDevice(deviceId);
  const token = device!.tokens!.operator!.token;
  const identity = resolveAuthenticatedDeviceTokenIdentity(device, {
    role: "operator",
    publicKey,
    token,
    scopes,
  });
  assert.ok(identity);
  const binding = {
    deviceId,
    publicKey,
    tokenIdentityKey: identity.key,
    agentId: "fixture",
    sessionKey: "agent:fixture:direct:control",
  };
  const state = await writeGatewayMaintenanceTransition({
    action: "begin",
    requestId: randomUUID(),
    ownerInstanceId: randomUUID(),
    binding,
  });
  await closeStateDatabaseForTest();
  await assert.rejects(
    assertOrdinaryGatewayMaintenanceReleased(),
    /ordinary startup remains disabled/,
  );
  const port = await getFreePort();
  const configRead = await readConfigFileSnapshotWithPluginMetadata({
    observe: false,
    allowCurrentPluginMetadata: false,
  });
  assert.ok(configRead.snapshot.valid, JSON.stringify(configRead.snapshot.issues));
  if (mode.startsWith("reject-")) {
    const refused = await runNodeScript(
      (workerArgv) => [
        ...workerArgv(
          resolveRuntimeWorkerUrl({
            currentModuleUrl: import.meta.url,
            sourceWorkerName: "maintenance-run.test-support",
            distWorkerPath: "gateway/maintenance-run.test-support.js",
          }),
        ),
        String(port),
      ],
      process.env,
      30_000,
      { requireProcessTreeExit: true },
    );
    assert.equal(refused.error, undefined, refused.stderr);
    assert.notEqual(refused.status, 0);
    assert.match(
      refused.stderr,
      mode === "reject-config"
        ? /valid local loopback config/
        : /has not opted into coordinator-only maintenance/,
    );
    assert.equal(existsSync(runtimeMarker), false, "Refusal must happen before plugin JS");
    assert.deepEqual(
      await readGatewayMaintenanceState(),
      state,
      "Refusal must preserve durable intent",
    );
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    return;
  }
  async function launchCold() {
    let child: ChildProcess | undefined;
    let exited = false;
    const result = runNodeScript(
      (workerArgv) => [
        ...workerArgv(
          resolveRuntimeWorkerUrl({
            currentModuleUrl: import.meta.url,
            sourceWorkerName: "maintenance-run.test-support",
            distWorkerPath: "gateway/maintenance-run.test-support.js",
          }),
        ),
        String(port),
      ],
      process.env,
      60_000,
      {
        requireProcessTreeExit: true,
        onReady(value) {
          child = value;
        },
      },
    ).finally(() => {
      exited = true;
    });
    const stop = async () => {
      child?.kill("SIGTERM");
      const completed = await result;
      assert.equal(completed.error, undefined, completed.stderr);
      assert.equal(completed.status, 0, completed.stderr);
    };
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (exited) {
          break;
        }
        try {
          if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 503) {
            return { close: stop };
          }
        } catch {
          /* Listener is not ready yet. */
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      throw new Error("Lean maintenance child did not listen");
    } catch (error) {
      await stop();
      throw error;
    }
  }
  const lock = cold
    ? undefined
    : await acquireGatewayLock({ port, listenerMode: "foreground", allowInTests: true });
  assert.ok(cold || lock);
  let server = cold
    ? await launchCold()
    : await startGatewayServer(port, { bind: "loopback", gatewayStateOwner: lock ?? undefined });
  const peers: ReturnType<typeof peer>[] = [];
  const connect = async (change?: (params: ReturnType<typeof paramsFor>) => void) => {
    const client = peer(port);
    peers.push(client);
    const challenge = await client.next();
    assert.equal(challenge.event, "connect.challenge");
    const nonce = record(challenge.payload).nonce;
    assert.equal(typeof nonce, "string");
    const params = paramsFor(String(nonce));
    change?.(params);
    return { client, result: await client.call("connect", params) };
  };
  function paramsFor(nonce: string) {
    const signedAt = Date.now();
    return {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "cli", mode: "cli", version: "fixture", platform: "linux" },
      role: "operator",
      scopes,
      auth: { deviceToken: token } as { deviceToken?: string; token?: string },
      device: {
        id: deviceId,
        publicKey,
        nonce,
        signedAt,
        signature: signDevicePayload(
          privateKey,
          buildDeviceAuthPayloadV3({
            deviceId,
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            scopes,
            signedAtMs: signedAt,
            token,
            nonce,
            platform: "linux",
          }),
        ),
      },
    };
  }
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 503);
    if (!cold) {
      assert.equal(tryBeginGatewayRootWorkAdmission(), null);
    }
    assert.equal(
      (
        await connect((params) => {
          params.auth = { token };
        })
      ).result.ok,
      false,
    );
    assert.equal(
      (
        await connect((params) => {
          params.device.nonce = randomUUID();
        })
      ).result.ok,
      false,
    );
    assert.equal(
      (
        await connect((params) => {
          params.device.signature = "invalid";
        })
      ).result.ok,
      false,
    );
    let { client, result } = await connect();
    assert.equal(result.ok, true);
    assert.equal(record(result.payload).maintenance, true);
    assert.equal((await client.call("sessions.create", { key: binding.sessionKey })).ok, false);
    assert.equal(
      (await client.call("gateway.maintenance.recover", { generation: state.generation + 1 })).ok,
      false,
    );
    const before = await client.call("gateway.maintenance.status", {
      generation: state.generation,
    });
    assert.equal(record(before.payload).owned, false);
    const recovered = await client.call("gateway.maintenance.recover", {
      generation: state.generation,
    });
    assert.equal(recovered.ok, true);
    const held = record(recovered.payload);
    assert.equal(held.owned, true);
    assert.equal(record(held.state).phase, "held");
    assert.equal(held.readyForEnrollment, false);
    if (cold) {
      for (const previous of peers) {
        previous.socket.terminate();
      }
      await server.close();
      server = await launchCold();
      ({ client, result } = await connect());
      assert.equal(result.ok, true);
      const restarted = await client.call("gateway.maintenance.status", {
        generation: state.generation,
      });
      assert.equal(
        record(restarted.payload).owned,
        false,
        "Restart never inherits old process authority",
      );
      assert.equal(record(record(restarted.payload).state).phase, "held");
      assert.equal(
        (await client.call("gateway.maintenance.release", { generation: state.generation })).ok,
        false,
      );
      assert.equal(
        (await client.call("gateway.maintenance.recover", { generation: state.generation })).ok,
        true,
      );
    }
    assert.equal(
      (await client.call("gateway.maintenance.enroll", { generation: state.generation })).ok,
      false,
    );
    const released = await client.call("gateway.maintenance.release", {
      generation: state.generation,
    });
    assert.equal(released.ok, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 503);
    assert.equal((await client.call("sessions.create", { key: binding.sessionKey })).ok, false);
    if (!cold) {
      assert.equal((await readGatewayMaintenanceState())?.phase, "released");
      assert.equal(tryBeginGatewayRootWorkAdmission(), null);
      await rotateDeviceToken({ deviceId, role: "operator" });
      assert.equal(
        (await client.call("gateway.maintenance.status", { generation: state.generation })).ok,
        false,
      );
    }
    assert.equal(existsSync(runtimeMarker), false, "Public startup must never load plugin JS");
  } finally {
    for (const client of peers) {
      client.socket.terminate();
    }
    await server.close();
    await lock?.release();
    await closeStateDatabaseForTest();
  }
  if (cold) {
    assert.equal((await readGatewayMaintenanceState())?.phase, "released");
  }
  const admission = tryBeginGatewayRootWorkAdmission();
  assert.ok(admission, "Only explicit close after durable release reopens admission");
  admission.release();
});
