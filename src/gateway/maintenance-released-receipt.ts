import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readExactSessionEntriesWithLifecycle } from "../config/sessions/session-entry-read.worker.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { configSourceSnapshotsMatch } from "../config/source.js";
import { initializeSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { verifyGatewayMaintenanceReleasedRequest } from "../infra/gateway-maintenance-released-request.js";
import { assertGatewayMaintenancePluginPolicy } from "../plugins/gateway-maintenance-policy.js";
import { resolvePluginMetadataSnapshotAsync } from "../plugins/plugin-metadata-snapshot.js";
import { holdGatewayMaintenanceAdmission } from "../process/gateway-work-admission.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  gatewayMaintenancePhysicalRead,
  assertGatewayMaintenancePhysicalReceipt,
} from "./maintenance-physical-receipt.js";

/** Offline read-only reconciliation, never a startup fallback. The launcher holds
 * the foreign-writer/config fence and journals the expected receipt. This process
 * retains admission closed and must exit after returning through private pipes. */
export async function readGatewayMaintenanceReleasedReceiptOffline(value: unknown) {
  const request = verifyGatewayMaintenanceReleasedRequest(value);
  await initializeSqliteRuntimeCapabilities();
  const admission = holdGatewayMaintenanceAdmission();
  const lock = await acquireGatewayLock({
    listenerMode: "foreground",
    role: "sqlite-maintenance",
    allowInTests: true,
    timeoutMs: 0,
  });
  if (!lock) {
    throw new Error("Released receipt requires exclusive offline Gateway ownership");
  }
  const assertCurrent = () => {
    admission.assertCurrent();
    lock.assertDatabaseAccess(resolveOpenClawStateSqlitePath());
  };
  const resources = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: assertCurrent,
    assertDatabaseAccess: (path) => lock.assertDatabaseAccess(path),
  });
  const readConfig = () =>
    readConfigFileSnapshotWithPluginMetadata({
      observe: false,
      isolateEnv: true,
      allowCurrentPluginMetadata: false,
      completePluginMetadata: true,
    });
  try {
    return await resources.run(() =>
      withArtifactPreservingStateReads(
        () =>
          withDevicePairingLock(async () => {
            assertCurrent();
            const prepared = await readConfig();
            assertCurrent();
            const cfg = prepared.snapshot.config;
            if (
              !prepared.snapshot.valid ||
              !prepared.snapshot.exists ||
              cfg.gateway?.mode === "remote" ||
              !listAgentIds(cfg).includes(request.agentId)
            ) {
              throw new Error(
                "Released receipt requires a valid local config with its exact agent",
              );
            }
            for (const workspaceDir of new Set(
              listAgentIds(cfg).map((id) => resolveAgentWorkspaceDir(cfg, id)),
            )) {
              const metadata = await resolvePluginMetadataSnapshotAsync({
                config: cfg,
                workspaceDir,
                allowCurrent: false,
              });
              assertCurrent();
              assertGatewayMaintenancePluginPolicy(cfg, metadata);
            }
            const result = await executeExistingOpenClawStateRead(
              {},
              {
                type: "gatewayMaintenance.releasedReceipt",
                input: request,
              },
            );
            assertCurrent();
            const planned = result?.state.receipt;
            if (!result || !planned) {
              throw new Error("Released maintenance receipt unavailable");
            }
            const state = result.state;
            const env = { ...process.env };
            const storePath = resolveSessionStorePathCore(cfg.session?.store, {
              agentId: request.agentId,
              env,
            });
            const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
            if (target.agentId !== state.binding.agentId || target.shared) {
              throw new Error("Released receipt requires the canonical per-agent session store");
            }
            // CLI one-shot exception: canonical native read kernel on an artifact-
            // preserving private copy, while exclusive source custody stays held.
            const opened = openOpenClawAgentDatabaseReadOnly({
              agentId: request.agentId,
              path: target.path,
              env,
            });
            if (!opened.found) {
              throw new Error("Released receipt physical database unavailable");
            }
            try {
              const facts = readExactSessionEntriesWithLifecycle(
                {
                  ...gatewayMaintenancePhysicalRead(state.binding, storePath, env),
                  env,
                  kind: "session-exact-entries",
                  database: opened.database,
                },
                opened.database,
              );
              assertGatewayMaintenancePhysicalReceipt(
                state.binding,
                planned,
                facts,
                opened.database.agentId,
              );
              const finalConfig = await readConfig();
              assertCurrent();
              if (!configSourceSnapshotsMatch(prepared.snapshot, finalConfig.snapshot)) {
                throw new Error("Released receipt config changed during verification");
              }
              return {
                version: 1 as const,
                state,
                receipt: planned,
                readOnly: true as const,
                readyForActivation: false as const,
              };
            } finally {
              opened.database.close();
            }
          }),
        { agentDatabases: true },
      ),
    );
  } finally {
    // Failed cleanup retains ownership; there is no mutation, release or normal runtime.
    await resources.close();
    await lock.release();
  }
}
