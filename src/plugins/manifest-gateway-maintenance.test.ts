import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertGatewayMaintenancePluginPolicy } from "./gateway-maintenance-policy.js";
import { createPluginRecord } from "./loader-records.js";
import { loadPluginRegistryHandle } from "./loader.js";
import { GATEWAY_MAINTENANCE_COORDINATOR_METHODS } from "./manifest-gateway-maintenance.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";

const roots: string[] = [];
const consent = { policy: "core-coordinator-v1" } as const;

function fixture(gatewayMaintenance: unknown, id = "maintenance-owner") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-plugin-")));
  roots.push(root);
  const pluginRoot = path.join(root, "plugin");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(stateDir);
  const ran = path.join(root, "runtime-ran");
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      configSchema: { type: "object", additionalProperties: false },
      gatewayMaintenance,
    }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, "index.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'loaded'); throw new Error('runtime forbidden');`,
  );
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } }),
  );
  const env = {
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "no-bundled-plugins"),
  };
  const config: OpenClawConfig = {
    plugins: {
      allow: [id],
      load: { paths: [pluginRoot] },
      entries: { [id]: { enabled: true } },
      slots: { memory: "none" },
    },
  };
  const snapshot = () =>
    resolvePluginMetadataSnapshot({
      config,
      env,
      stateDir,
      workspaceDir: path.join(root, "workspace"),
    });
  return { id, pluginRoot, config, snapshot, ran, env };
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  null,
  true,
  "core-coordinator-v1",
  {},
  { policy: "core-coordinator-v2" },
  { policy: "core-coordinator-v1", methods: ["sessions.create"] },
])("rejects malformed or expanded maintenance consent: %j", (value) => {
  const owner = fixture(value);
  expect(loadPluginManifest(owner.pluginRoot)).toMatchObject({
    ok: false,
    error: expect.stringContaining("gatewayMaintenance"),
  });
  expect(() => assertGatewayMaintenancePluginPolicy(owner.config, owner.snapshot())).toThrow();
  expect(fs.existsSync(owner.ran)).toBe(false);
});

it("admits explicit consent from complete metadata without executing plugin JavaScript", () => {
  const owner = fixture(consent);
  const snapshot = owner.snapshot();
  expect(snapshot.byPluginId.get(owner.id)?.gatewayMaintenance).toEqual(consent);
  expect(assertGatewayMaintenancePluginPolicy(owner.config, snapshot)).toEqual([owner.id]);
  expect(fs.existsSync(owner.ran)).toBe(false);
  expect(GATEWAY_MAINTENANCE_COORDINATOR_METHODS).toEqual([
    "gateway.maintenance.status",
    "gateway.maintenance.recover",
    "gateway.maintenance.enroll",
    "gateway.maintenance.release",
  ]);
  expect(() =>
    assertGatewayMaintenancePluginPolicy(owner.config, { ...snapshot, pluginIds: [owner.id] }),
  ).toThrow(/complete/);
  expect(() =>
    assertGatewayMaintenancePluginPolicy(owner.config, { ...snapshot, byPluginId: new Map() }),
  ).toThrow(/missing plugin metadata/);
  expect(() =>
    assertGatewayMaintenancePluginPolicy(
      { ...owner.config, plugins: { ...owner.config.plugins, allow: [owner.id, "missing-owner"] } },
      snapshot,
    ),
  ).toThrow(/missing plugin metadata/);
});

it("default-refuses an undeclared plugin and supports explicit global disablement", () => {
  const owner = fixture(undefined);
  const snapshot = owner.snapshot();
  expect(loadPluginManifest(owner.pluginRoot)).toMatchObject({ ok: true });
  expect(() => assertGatewayMaintenancePluginPolicy(owner.config, snapshot)).toThrow(
    /has not opted/,
  );
  expect(assertGatewayMaintenancePluginPolicy({ plugins: { enabled: false } }, snapshot)).toEqual(
    [],
  );
});

it("does not substitute manifest consent for configured operator roles", () => {
  const owner = fixture(consent);
  const config: OpenClawConfig = {
    ...owner.config,
    gateway: {
      roles: {
        default: "staff",
        definitions: {
          staff: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
        },
      },
    },
  };
  expect(() => assertGatewayMaintenancePluginPolicy(config, owner.snapshot())).toThrow(
    /operator role policies/,
  );
});

it("rejects conflicting normal access-policy registration while preserving undeclared plugins", () => {
  for (const gatewayMaintenance of [consent, undefined]) {
    const registry = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "policy-owner",
      source: "fixture",
      origin: "workspace",
      enabled: true,
      configSchema: false,
      gatewayMaintenance,
    });
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, { config: {}, registrationMode: "full" });
    const register = () => api.registerGatewayAccessPolicy({ authorize: () => undefined });
    if (gatewayMaintenance) {
      expect(register).toThrow(/conflicts/);
      expect(registry.registry.gatewayAccessPolicies).toEqual([]);
    } else {
      expect(register).not.toThrow();
      expect(registry.registry.gatewayAccessPolicies).toHaveLength(1);
    }
  }
});

it.each(["maintenance-owner", "openrouter"])(
  "carries %s consent through the normal manifest loader before rejecting conflicting code",
  (id) => {
    const owner = fixture(consent, id);
    fs.writeFileSync(
      path.join(owner.pluginRoot, "index.cjs"),
      `module.exports = { id: "${owner.id}", register(api) { api.registerGatewayAccessPolicy({ authorize() { return undefined; } }); } };`,
    );
    const registry = loadPluginRegistryHandle({
      config: owner.config,
      env: owner.env,
      cache: false,
      runtimeSideEffects: false,
    });
    expect(registry.plugins.find((plugin) => plugin.id === owner.id)).toMatchObject({
      gatewayMaintenance: consent,
      status: "error",
      failurePhase: "register",
      error: expect.stringContaining("conflicts"),
    });
    expect(registry.gatewayAccessPolicies).toEqual([]);
  },
);

it.each(["memory", "contextEngine"] as const)(
  "refuses unsupported %s slot owners outside the allowlist",
  (slot) => {
    const owner = fixture(consent);
    const slotOwner = fixture(undefined, "slot-owner");
    owner.config.plugins!.load!.paths!.push(slotOwner.pluginRoot);
    owner.config.plugins!.slots = { memory: "none", [slot]: slotOwner.id };
    const snapshot = owner.snapshot();
    expect(snapshot.byPluginId.has(slotOwner.id)).toBe(true);
    expect(() => assertGatewayMaintenancePluginPolicy(owner.config, snapshot)).toThrow(
      /memory slot none and no custom context engine/,
    );
    expect(fs.existsSync(owner.ran)).toBe(false);
    expect(fs.existsSync(slotOwner.ran)).toBe(false);
  },
);

it("refuses the implicit default memory slot and dreaming sidecar configurations", () => {
  const owner = fixture(consent);
  delete owner.config.plugins!.slots;
  expect(() => assertGatewayMaintenancePluginPolicy(owner.config, owner.snapshot())).toThrow(
    /memory slot none/,
  );
  owner.config.plugins!.slots = { memory: "custom-memory" };
  owner.config.plugins!.entries!["memory-core"] = { config: { dreaming: { enabled: true } } };
  expect(() => assertGatewayMaintenancePluginPolicy(owner.config, owner.snapshot())).toThrow(
    /memory slot none/,
  );
});
