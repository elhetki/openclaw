import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveSelectedContextEnginePluginId } from "./config-state.js";
import { isManifestPluginAvailableForControlPlane } from "./manifest-contract-eligibility.js";
import { parsePluginGatewayMaintenance } from "./manifest-gateway-maintenance.js";
import { isActivatedManifestOwner } from "./manifest-owner-policy.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

/** Validate one complete, owner-prepared workspace metadata snapshot before loading JS.
 * Startup must cover every workspace and retain the same config/metadata generation.
 * This does not authenticate a coordinator or prove that writers have drained. */
export function assertGatewayMaintenancePluginPolicy(
  config: OpenClawConfig,
  snapshot: PluginMetadataSnapshot,
): readonly string[] {
  if (config.gateway?.roles) {
    throw new Error("Gateway maintenance cannot bypass configured operator role policies");
  }
  const normalizedConfig = normalizePluginsConfig(config.plugins);
  if (!normalizedConfig.enabled) {
    return [];
  }
  // Runtime slot owners can authorize additional sidecars outside allowlists.
  // The initial recovery context has no memory/engine policy adapter.
  if (normalizedConfig.slots.memory !== null || resolveSelectedContextEnginePluginId(config)) {
    throw new Error("Gateway maintenance requires memory slot none and no custom context engine");
  }
  if (
    snapshot.pluginIds !== undefined ||
    !["derived", "persisted"].includes(snapshot.registrySource ?? "") ||
    (snapshot.registrySource !== "derived" &&
      snapshot.registryDiagnostics.some((diagnostic) => diagnostic.level === "warn")) ||
    snapshot.diagnostics.some((diagnostic) => diagnostic.level === "error")
  ) {
    throw new Error("Gateway maintenance requires complete verified plugin metadata");
  }
  const requiredIds = new Set([
    ...normalizedConfig.allow,
    ...Object.entries(normalizedConfig.entries)
      .filter(([, entry]) => entry.enabled === true)
      .map(([id]) => id),
    ...snapshot.index.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.pluginId),
  ]);
  for (const id of requiredIds) {
    if (!snapshot.byPluginId.has(snapshot.normalizePluginId(id))) {
      throw new Error(`Gateway maintenance is missing plugin metadata for ${id}`);
    }
  }
  const admitted = new Set<string>();
  for (const plugin of snapshot.plugins) {
    // Conservatively require consent from all available owners, even if a lazy
    // activation plan would not happen to import them on this particular boot.
    if (
      !isActivatedManifestOwner({ plugin, normalizedConfig, rootConfig: config }) &&
      !isManifestPluginAvailableForControlPlane({ snapshot, plugin, config, normalizedConfig })
    ) {
      continue;
    }
    if (!parsePluginGatewayMaintenance(plugin.gatewayMaintenance)) {
      throw new Error(`Plugin ${plugin.id} has not opted into coordinator-only maintenance`);
    }
    admitted.add(plugin.id);
  }
  return Object.freeze([...admitted].toSorted());
}
