import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { publicKeyRawBase64UrlFromPem, signDevicePayload } from "../infra/device-identity.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { executeDevicePairingMutation } from "../infra/device-pairing-worker.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { buildGatewayMaintenanceBootstrapPayload } from "../infra/gateway-maintenance-bootstrap-request.js";
import { buildGatewayMaintenanceReleasedPayload } from "../infra/gateway-maintenance-released-request.js";
import { operateGatewayMaintenanceRecovery } from "../infra/gateway-maintenance-store.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  prepareGatewayMaintenanceHomeDevice,
  enrollGatewayMaintenanceHomeSession,
  withVerifiedGatewayMaintenanceHomeSession,
} from "./maintenance-enrollment.js";

if (process.argv[2] === "cli") {
  const { Command } = await import("commander");
  const { addGatewayMaintenanceBootstrapCommand } =
    await import("../cli/gateway-cli/register-maintenance-bootstrap.js");
  const command = new Command();
  addGatewayMaintenanceBootstrapCommand(command);
  await command.parseAsync(["maintenance-released-receipt", "--request-stdin"], { from: "user" });
} else {
  await withOpenClawTestState({ label: "maintenance-released-receipt" }, async (fixture) => {
    const mode = process.argv[2];
    const marker = fixture.path("forbidden-plugin");
    await fixture.writeJson("plugin/openclaw.plugin.json", {
      id: "receipt-fixture",
      gatewayMaintenance: { policy: "core-coordinator-v1" },
      configSchema: { type: "object" },
    });
    await fixture.writeJson("plugin/package.json", {
      name: "receipt-fixture",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    });
    await fixture.writeText(
      "plugin/index.cjs",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'forbidden'); throw new Error('Plugin must not load');`,
    );
    const cfg = {
      gateway: { mode: "local" as const, bind: "loopback" as const },
      agents: { entries: { fixture: { workspace: fixture.workspaceDir } } },
      plugins: {
        allow: ["receipt-fixture"],
        load: { paths: [fixture.statePath("plugin")] },
        entries: { "receipt-fixture": { enabled: true } },
        slots: { memory: "none" },
      },
    };
    await fixture.writeConfig(cfg);
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicKey = publicKeyRawBase64UrlFromPem(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    const bootstrapRequest = {
      requestId: randomUUID(),
      agentId: "fixture",
      sessionKey: "agent:fixture:direct:receipt",
      publicKey,
      signedAt: Date.now(),
    };
    const bootstrap = await executeDevicePairingMutation({
      type: "devicePairing.bootstrapMaintenance",
      input: {
        ownerInstanceId: randomUUID(),
        request: {
          ...bootstrapRequest,
          signature: signDevicePayload(
            privateKey,
            buildGatewayMaintenanceBootstrapPayload(bootstrapRequest),
          ),
        },
      },
    });
    await closeStateDatabaseForTest();
    const authority = {
      generation: bootstrap.state.generation,
      binding: bootstrap.state.binding,
      token: bootstrap.credential.token,
    };
    const ownerInstanceId = bootstrap.state.ownerInstanceId;
    const lock = await acquireGatewayLock({ allowInTests: true, listenerMode: "foreground" });
    assert.ok(lock);
    const guard = () => lock.assertDatabaseAccess(resolveOpenClawStateSqlitePath());
    const resources = createOpenClawDatabaseMaintenanceScope({
      assertOwnerCurrent: guard,
      assertDatabaseAccess: (file) => lock.assertDatabaseAccess(file),
    });
    const homePublicKey = publicKeyRawBase64UrlFromPem(
      generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }),
    );
    const enrollment = {
      requestId: randomUUID(),
      homePublicKey,
      agentId: bootstrapRequest.agentId,
      sessionKey: bootstrapRequest.sessionKey,
    };
    const input = { ...authority, ownerInstanceId, request: enrollment };
    const options = { config: cfg, resources, assertCurrent: guard };
    let enrolled;
    try {
      await operateGatewayMaintenanceRecovery(
        {
          ...authority,
          command: { action: "hold", generation: authority.generation, ownerInstanceId },
        },
        guard,
      );
      await prepareGatewayMaintenanceHomeDevice(input, guard);
      enrolled = await enrollGatewayMaintenanceHomeSession(input, options);
      // Commit release and deliberately discard its acknowledgment. No saved reply
      // may supply reconciliation; the next reader runs in a fresh process.
      await withVerifiedGatewayMaintenanceHomeSession(input, options, (_receipt, assertCurrent) =>
        operateGatewayMaintenanceRecovery(
          {
            ...authority,
            command: { action: "release", generation: authority.generation, ownerInstanceId },
          },
          assertCurrent,
        ),
      );
    } finally {
      await resources.close();
      await closeStateDatabaseForTest();
      await lock.release();
    }
    assert.ok(enrolled?.receipt);
    const request = (changes = {}, signingKey = privateKey) => {
      const value = {
        generation: authority.generation,
        requestId: bootstrapRequest.requestId,
        enrollmentRequestId: enrollment.requestId,
        agentId: enrollment.agentId,
        sessionKey: enrollment.sessionKey,
        publicKey,
        token: authority.token,
        signedAt: Date.now(),
        ...changes,
      };
      return {
        ...value,
        signature: signDevicePayload(signingKey, buildGatewayMaintenanceReleasedPayload(value)),
      };
    };
    const invoke = async (value: unknown) => {
      let stdout = "";
      let stderr = "";
      const status = await runManagedCommand({
        bin: process.execPath,
        args: [
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl({
              currentModuleUrl: import.meta.url,
              sourceWorkerName: "maintenance-released-receipt.test-support",
              distWorkerPath: "gateway/maintenance-released-receipt.test-support.js",
            }),
            process.execPath,
          ),
          "cli",
        ],
        env: { ...process.env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
        timeoutMs: 30_000,
        requireProcessTreeExit: true,
        stdio: ["pipe", "pipe", "pipe"],
        onReady(child) {
          child.stdout!.on("data", (chunk) => {
            stdout += String(chunk);
          });
          child.stderr!.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.stdin!.end(JSON.stringify(value));
        },
      });
      assert.equal(stdout.includes(authority.token), false);
      assert.equal(stderr.includes(authority.token), false);
      return { status, stdout, stderr };
    };
    const artifacts = async () => {
      const entries: Record<string, string> = {};
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(file);
          } else if (/\.sqlite(?:-wal|-shm)?$/.test(entry.name)) {
            entries[file] = createHash("sha256")
              .update(await readFile(file))
              .digest("hex");
          }
        }
      };
      await walk(fixture.stateDir);
      return entries;
    };
    const before = await artifacts();
    const first = await invoke(request());
    assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(first.stdout);
    assert.equal(receipt.state.phase, "released");
    assert.deepEqual(receipt.receipt, enrolled.receipt);
    assert.equal(receipt.readOnly, true);
    assert.equal(receipt.readyForActivation, false);
    assert.deepEqual(
      await artifacts(),
      before,
      "Read-only CLI must preserve every source database artifact",
    );
    if (mode === "restart") {
      const retry = await invoke(request());
      assert.equal(retry.status, 0, retry.stderr);
      assert.deepEqual(JSON.parse(retry.stdout), receipt);
      const foreign = generateKeyPairSync("ed25519");
      for (const invalid of [
        request(
          {
            publicKey: publicKeyRawBase64UrlFromPem(
              foreign.publicKey.export({ type: "spki", format: "pem" }),
            ),
          },
          foreign.privateKey.export({ type: "pkcs8", format: "pem" }),
        ),
        request({ generation: authority.generation + 1 }),
        request({ token: randomUUID() }),
        request(
          {},
          generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
        ),
        request({ enrollmentRequestId: randomUUID() }),
      ]) {
        assert.notEqual((await invoke(invalid)).status, 0);
      }
      assert.deepEqual(await artifacts(), before);
      const concurrent = await acquireGatewayLock({
        allowInTests: true,
        listenerMode: "foreground",
      });
      assert.ok(concurrent);
      try {
        // Normal Gateway ownership itself opens source WAL/SHM. Compare the
        // refused reader against that owner's already-established artifacts.
        const owned = await artifacts();
        assert.notEqual((await invoke(request())).status, 0);
        assert.deepEqual(await artifacts(), owned);
      } finally {
        await concurrent.release();
      }
    } else {
      if (mode === "home") {
        await rotateDeviceToken({ deviceId: enrolled.credential.deviceId, role: "operator" });
      } else {
        const { updateSessionEntry, appendTranscriptMessage } =
          await import("../config/sessions/session-accessor.js");
        const scope = {
          agentId: enrollment.agentId,
          sessionKey: enrollment.sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: enrollment.agentId }),
          env: process.env,
        };
        if (mode === "session") {
          await updateSessionEntry(scope, () => ({ lifecycleRevision: randomUUID() }));
        } else {
          await appendTranscriptMessage(
            { ...scope, sessionId: enrolled.receipt.sessionId },
            { message: { role: "user", content: "Synthetic post-release message" } },
          );
        }
      }
      await closeStateDatabaseForTest();
      const changed = await artifacts();
      assert.notEqual((await invoke(request())).status, 0);
      assert.deepEqual(await artifacts(), changed);
    }
    assert.equal(existsSync(marker), false, "Offline receipt must not run plugin JS");
  });
}
