import { runGatewayMaintenanceControl } from "../cli/gateway-cli/maintenance-run.js";

await runGatewayMaintenanceControl(Number(process.argv[2]));
