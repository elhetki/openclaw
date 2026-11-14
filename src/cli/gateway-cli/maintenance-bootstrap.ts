import { bootstrapGatewayMaintenanceOffline } from "../../gateway/maintenance-bootstrap.js";
import type { OutputRuntimeEnv } from "../../runtime.js";
import { readMaintenancePrivatePipeRequest } from "./maintenance-private-pipe.js";

export async function runMaintenanceBootstrapCli(runtime: OutputRuntimeEnv): Promise<void> {
  const request = await readMaintenancePrivatePipeRequest();
  const receipt = await bootstrapGatewayMaintenanceOffline(request);
  runtime.writeJson(receipt);
}
