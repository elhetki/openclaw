import { startGatewayMaintenanceIfRequired } from "../../gateway/maintenance-startup.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import { GatewayStartupCleanupError } from "../../gateway/server-shutdown.js";
import { initializeSqliteRuntimeCapabilities } from "../../infra/bun-sqlite-library.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";

/** Foreground control-only process. Absence/release never selects ordinary startup. */
export async function runGatewayMaintenanceControl(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid maintenance control port");
  }
  await initializeSqliteRuntimeCapabilities();
  const lock = await acquireGatewayLock({ port, listenerMode: "foreground", allowInTests: true });
  if (!lock) {
    throw new Error("Maintenance runtime requires exclusive Gateway ownership");
  }
  const stop = Promise.withResolvers<void>();
  const abort = new AbortController();
  const onStop = () => {
    abort.abort();
    stop.resolve();
  };
  process.once("SIGTERM", onStop);
  process.once("SIGINT", onStop);
  const refuseInProcessRestart = () => {};
  process.on("SIGUSR1", refuseInProcessRestart);
  let server: GatewayServer | undefined;
  try {
    server = await startGatewayMaintenanceIfRequired(
      port,
      { bind: "loopback", gatewayStateOwner: lock },
      abort.signal,
    );
    if (!server) {
      throw new Error("No active maintenance intent; refusing ordinary startup");
    }
    await server.startupSettled;
    await stop.promise;
    await server.close();
    server = undefined;
    await lock.release();
  } catch (error) {
    // A failed resource join must not release ownership over still-live workers.
    if (error instanceof GatewayStartupCleanupError) {
      throw error;
    }
    await server?.close();
    await lock.release();
    if (!abort.signal.aborted) {
      throw error;
    }
  } finally {
    process.removeListener("SIGTERM", onStop);
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGUSR1", refuseInProcessRestart);
  }
}
