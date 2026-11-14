import { readGatewayMaintenanceState } from "../infra/gateway-maintenance-store.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { holdGatewayMaintenanceAdmission } from "../process/gateway-work-admission.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import { rethrowGatewayStartupError } from "./server-shutdown.js";

/** Ordinary CLI preflight must not migrate/repair state under an active intent. */
export async function assertOrdinaryGatewayMaintenanceReleased(): Promise<void> {
  let state;
  try {
    state = await withArtifactPreservingStateReads(() => readGatewayMaintenanceState());
  } catch (cause) {
    throw new StartupMaintenanceRequiredError(
      "coordinator-maintenance",
      "Gateway maintenance state could not be verified",
      { cause },
    );
  }
  if (state && state.phase !== "released") {
    throw new StartupMaintenanceRequiredError(
      "coordinator-maintenance",
      "An active maintenance intent requires gateway maintenance-run; ordinary startup remains disabled",
    );
  }
}

/** Select the cold recovery runtime before normal server resources exist.
 * Unreadable state stays closed; there is no minimal-test/canary bypass. */
export async function startGatewayMaintenanceIfRequired(
  port: number,
  options: GatewayServerOptions,
  ownerSignal?: AbortSignal,
): Promise<GatewayServer | undefined> {
  let state;
  try {
    state = await withArtifactPreservingStateReads(() => readGatewayMaintenanceState());
  } catch (cause) {
    throw new StartupMaintenanceRequiredError(
      "coordinator-maintenance",
      "Gateway maintenance state could not be verified",
      { cause },
    );
  }
  if (!state || state.phase === "released") {
    return undefined;
  }
  if (!options.gatewayStateOwner) {
    throw new StartupMaintenanceRequiredError(
      "coordinator-maintenance",
      "Maintenance recovery requires exclusive Gateway state ownership",
    );
  }
  const selected = state;
  // Restore the process fence before metadata preparation or any producer setup.
  // Failure retains it; this process must never fall back to ordinary startup.
  const admission = holdGatewayMaintenanceAdmission();
  const start = async (signal?: AbortSignal): Promise<GatewayServer> => {
    const [
      { readConfigFileSnapshotWithPluginMetadata },
      { createConfigFileAdapter },
      { configSourceSnapshotsMatch },
      { listAgentIds, resolveAgentWorkspaceDir },
      { resolvePluginMetadataSnapshotAsync },
      { assertGatewayMaintenancePluginPolicy },
      { startMaintenanceControlServer },
      { createSubsystemLogger },
    ] = await Promise.all([
      import("../config/io.js"),
      import("../config/source-file.js"),
      import("../config/source.js"),
      import("../agents/agent-scope.js"),
      import("../plugins/plugin-metadata-snapshot.js"),
      import("../plugins/gateway-maintenance-policy.js"),
      import("./maintenance-control-server.js"),
      import("../logging/subsystem.js"),
    ]);
    const log = createSubsystemLogger("gateway/maintenance");
    let invalidated = false;
    let watchingCurrent: (() => boolean) | undefined;
    const assertOwner = () => {
      signal?.throwIfAborted();
      ownerSignal?.throwIfAborted();
      options.gatewayStateOwner?.assertDatabaseAccess(resolveOpenClawStateSqlitePath());
      if (invalidated || (watchingCurrent && !watchingCurrent())) {
        throw new Error("Maintenance config observation changed; explicit restart required");
      }
    };
    assertOwner();
    const read = () =>
      withArtifactPreservingStateReads(() =>
        readConfigFileSnapshotWithPluginMetadata({
          observe: false,
          allowCurrentPluginMetadata: false,
          completePluginMetadata: true,
          isolateEnv: true,
        }),
      );
    const prepared = await read();
    assertOwner();
    const cfg = prepared.snapshot.config;
    if (
      !prepared.snapshot.exists ||
      !prepared.snapshot.valid ||
      (options.host && options.host !== "127.0.0.1") ||
      (options.bind && options.bind !== "loopback") ||
      (cfg.gateway?.bind && cfg.gateway.bind !== "loopback") ||
      cfg.gateway?.mode === "remote" ||
      !listAgentIds(cfg).includes(selected.binding.agentId)
    ) {
      throw new Error("Maintenance requires a valid local loopback config with its exact agent");
    }
    for (const workspaceDir of new Set(
      listAgentIds(cfg).map((id) => resolveAgentWorkspaceDir(cfg, id)),
    )) {
      const metadata = await withArtifactPreservingStateReads(() =>
        resolvePluginMetadataSnapshotAsync({ config: cfg, workspaceDir, allowCurrent: false }),
      );
      assertOwner();
      assertGatewayMaintenancePluginPolicy(cfg, metadata);
    }
    const ready = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});
    const observation = createConfigFileAdapter({
      path: prepared.snapshot.path,
      includedPaths: prepared.snapshot.includedPaths,
      onChange() {
        invalidated = true;
        ready.reject(new Error("Maintenance config changed during observation"));
      },
      onReady(current) {
        watchingCurrent = current;
        ready.resolve();
      },
      log,
    });
    const timeout = setTimeout(
      () => ready.reject(new Error("Maintenance config observation did not become ready")),
      15_000,
    );
    const interrupted = () => ready.reject(new Error("Maintenance startup interrupted"));
    signal?.addEventListener("abort", interrupted, { once: true });
    ownerSignal?.addEventListener("abort", interrupted, { once: true });
    const closeDatabase = async () => {
      const { closeOpenClawStateDatabaseByPathAsync } =
        await import("../state/openclaw-state-db.js");
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath());
    };
    let server: Awaited<ReturnType<typeof startMaintenanceControlServer>> | undefined;
    try {
      observation.start();
      await ready.promise;
      assertOwner();
      // Close the read/watch gap once at startup; request paths use the observation owner.
      const verified = await read();
      assertOwner();
      if (!configSourceSnapshotsMatch(prepared.snapshot, verified.snapshot)) {
        throw new Error("Maintenance config changed before listener startup");
      }
      server = await startMaintenanceControlServer({
        port,
        state: selected,
        admission,
        assertCurrent: assertOwner,
        onListening: options.gatewayStateOwner?.markListening,
      });
      assertOwner();
      log.warn("Gateway is in coordinator-only maintenance; ordinary ingress remains unavailable");
      const ownedServer = server;
      let closing: Promise<void> | undefined;
      return {
        startupSettled: ownedServer.startupSettled,
        getTailscaleIngressEndpoint: ownedServer.getTailscaleIngressEndpoint,
        close: (closeOptions) =>
          (closing ??= (async () => {
            await ownedServer.close(closeOptions);
            await observation.stop();
            await closeDatabase();
            if (ownedServer.isDurablyReleased()) {
              admission.release();
            }
          })()),
      };
    } catch (error) {
      return rethrowGatewayStartupError(error, async () => {
        await server?.close();
        await observation.stop();
        await closeDatabase();
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", interrupted);
      ownerSignal?.removeEventListener("abort", interrupted);
    }
  };
  return options.startupOperation ? options.startupOperation(start) : start();
}
