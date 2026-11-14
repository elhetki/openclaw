import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";

export function addGatewayMaintenanceBootstrapCommand(gateway: Command): void {
  gateway
    .command("maintenance-run")
    .description("Run only the coordinator listener for an existing maintenance intent")
    .requiredOption("--port <port>", "Exact loopback control port")
    .action(async (opts: { port: string }) => {
      try {
        const port = parseStrictPositiveInteger(opts.port);
        if (!port || port > 65535) {
          throw new Error("Invalid maintenance control port");
        }
        const { runGatewayMaintenanceControl } = await import("./maintenance-run.js");
        await runGatewayMaintenanceControl(port);
      } catch (error) {
        defaultRuntime.error(`Maintenance runtime failed: ${formatErrorMessage(error)}`);
        defaultRuntime.exit(1);
      }
    });
  gateway
    .command("maintenance-bootstrap")
    .description("Initialize the first coordinator maintenance intent under offline host custody")
    .option(
      "--request-stdin",
      "Read a signed initialization request and return its secret receipt over private pipes",
      false,
    )
    .action(async (opts: { requestStdin?: boolean }) => {
      try {
        if (!opts.requestStdin) {
          throw new Error("Pass --request-stdin for explicit offline maintenance initialization");
        }
        const { runMaintenanceBootstrapCli } = await import("./maintenance-bootstrap.js");
        await runMaintenanceBootstrapCli(defaultRuntime);
      } catch (error) {
        defaultRuntime.error(`Offline maintenance bootstrap failed: ${formatErrorMessage(error)}`);
        defaultRuntime.exit(1);
      }
    });
}
