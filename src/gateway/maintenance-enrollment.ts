import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { createSessionEntryWithTranscript } from "../config/sessions/session-accessor.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryWorkerRead } from "../config/sessions/session-entry-read-runtime.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import { executeDevicePairingMutation } from "../infra/device-pairing-worker.js";
import type { GatewayMaintenanceAuthority } from "../infra/gateway-maintenance-authority.kernel.js";
import type { GatewayMaintenanceHomeRequest } from "../infra/gateway-maintenance-home.kernel.js";
import type { GatewayMaintenanceReceipt } from "../infra/gateway-maintenance-state.js";
import type { OpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import {
  gatewayMaintenancePhysicalRead,
  withGatewayMaintenancePhysicalReceipt,
} from "./maintenance-physical-receipt.js";

export type GatewayMaintenanceEnrollmentInput = GatewayMaintenanceAuthority & {
  ownerInstanceId: string;
  request: GatewayMaintenanceHomeRequest;
};
type EnrollmentOptions = {
  config: OpenClawConfig;
  assertCurrent: () => void;
  resources: OpenClawDatabaseMaintenanceScope;
};

export function prepareGatewayMaintenanceHomeDevice(
  input: GatewayMaintenanceEnrollmentInput,
  assertCurrent: () => void,
) {
  return executeDevicePairingMutation(
    { type: "devicePairing.enrollMaintenanceHome", input: { ...input, action: "prepare" } },
    { assertCurrent },
  );
}

async function withHomeOperation<T>(
  input: GatewayMaintenanceEnrollmentInput,
  options: EnrollmentOptions,
  operate: (context: {
    device: Awaited<ReturnType<typeof prepareGatewayMaintenanceHomeDevice>>;
    read: SessionEntryWorkerRead;
    assertCurrent: () => void;
    storePath: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<T>,
) {
  return withDevicePairingLock(async () => {
    let active = true;
    const assertCurrent = () => {
      if (!active) {
        throw new Error("Maintenance pairing custody ended");
      }
      options.assertCurrent();
    };
    try {
      return await options.resources.run(async () => {
        assertCurrent();
        // Cold runtime only: the domain lock excludes canonical credential writers
        // throughout the agent-store effect. Host custody excludes foreign writers.
        const device = await executeDevicePairingMutation(
          { type: "devicePairing.enrollMaintenanceHome", input: { ...input, action: "read" } },
          { assertCurrent },
        );
        assertCurrent();
        if (
          !device.state.enrollment ||
          !["enrollment_pending", "enrolled"].includes(device.state.phase)
        ) {
          throw new Error("Maintenance device step is incomplete");
        }
        const env = { ...process.env };
        const storePath = resolveSessionStorePathCore(options.config.session?.store, {
          agentId: input.binding.agentId,
          env,
        });
        const read = gatewayMaintenancePhysicalRead(input.binding, storePath, env);
        return await operate({ device, read, assertCurrent, storePath, env });
      });
    } finally {
      active = false;
    }
  });
}

/** The second durable step creates only on physical absence; a lost reply is
 * reconciled against the exact planned incarnation, never by adopting a key. */
export function enrollGatewayMaintenanceHomeSession(
  input: GatewayMaintenanceEnrollmentInput,
  options: EnrollmentOptions,
) {
  return withHomeOperation(input, options, async (context) => {
    const before = await readSessionEntriesFromStoreInWorker(context.read);
    context.assertCurrent();
    if (before.entries.length === 0 && context.device.state.phase === "enrollment_pending") {
      const created = await createSessionEntryWithTranscript(
        {
          agentId: input.binding.agentId,
          sessionKey: input.binding.sessionKey,
          storePath: context.storePath,
          env: context.env,
        },
        ({ existingEntry, targetEntry }) => {
          if (existingEntry || targetEntry) {
            return { ok: false as const, error: "Maintenance session already exists" };
          }
          return {
            ok: true as const,
            entry: {
              ...context.device.planned,
              updatedAt: Date.now(),
              chatType: "direct" as const,
              spawnDepth: 0,
            },
          };
        },
        {
          requireAbsent: true,
          commitGuard: context.assertCurrent,
          cwd: resolveAgentWorkspaceDir(options.config, input.binding.agentId),
          activeSessionKey: input.binding.sessionKey,
        },
      );
      if (!created.ok) {
        throw new Error("Maintenance session absence was not preserved");
      }
    }
    return withGatewayMaintenancePhysicalReceipt(
      {
        read: context.read,
        assertCurrent: context.assertCurrent,
        planned: context.device.planned,
        binding: input.binding,
      },
      async (receipt, assertCurrent) =>
        executeDevicePairingMutation(
          {
            type: "devicePairing.enrollMaintenanceHome",
            input: { ...input, action: "confirm", receipt },
          },
          { assertCurrent },
        ),
    );
  });
}

/** Release composes its shared-store CAS inside this retained physical reader.
 * No detached result may serve as final session authority after an await. */
export function withVerifiedGatewayMaintenanceHomeSession<T>(
  input: GatewayMaintenanceEnrollmentInput,
  options: EnrollmentOptions,
  consume: (receipt: GatewayMaintenanceReceipt, assertCurrent: () => void) => Promise<T>,
) {
  return withHomeOperation(input, options, (context) =>
    withGatewayMaintenancePhysicalReceipt(
      {
        read: context.read,
        assertCurrent: context.assertCurrent,
        planned: context.device.planned,
        binding: input.binding,
      },
      consume,
    ),
  );
}
