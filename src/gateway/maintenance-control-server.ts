import { randomUUID } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  validateConnectParams,
  validateGatewayMaintenanceGenerationParams,
  validateRequestFrame,
} from "../../packages/gateway-protocol/src/index.js";
import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import type { GatewayMaintenanceState } from "../infra/gateway-maintenance-state.js";
import { operateGatewayMaintenanceRecovery } from "../infra/gateway-maintenance-store.js";
import { rawDataToString } from "../infra/ws.js";
import type { holdGatewayMaintenanceAdmission } from "../process/gateway-work-admission.js";
import { verifyMaintenanceCoordinatorProof } from "./maintenance-coordinator-auth.js";
import type { GatewayServer } from "./server-public.js";

/** Cold control runtime only: the caller must own state/config custody, admit all
 * plugin manifests, and never have created normal Gateway server resources.
 * Global work inspection cannot substitute for inspectors of a live normal server.
 * No plugin JS, scheduler, ordinary RPC router, HTTP API, or automatic resume. */
export async function startMaintenanceControlServer(options: {
  port: number;
  state: GatewayMaintenanceState;
  admission: ReturnType<typeof holdGatewayMaintenanceAdmission>;
  assertCurrent: () => void;
  onListening?: () => void;
}): Promise<GatewayServer & { isDurablyReleased: () => boolean }> {
  const hold = options.admission;
  const ownerInstanceId = randomUUID();
  const binding = options.state.binding;
  const generation = options.state.generation;
  const work = new Set<Promise<void>>();
  let closing = false;
  let released = false;
  let busy = false;
  let uncertain = false;
  const assertCurrent = () => {
    options.assertCurrent();
    hold.assertCurrent();
    if (closing || uncertain) {
      throw new Error("Maintenance runtime requires reconciliation");
    }
  };
  assertCurrent();
  const httpServer = http.createServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("Gateway is in coordinator-only maintenance\n");
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 16_384,
    perMessageDeflate: false,
  });
  httpServer.on("upgrade", (request, socket, head) => {
    if (
      closing ||
      sockets.clients.size >= 4 ||
      request.socket.remoteAddress !== "127.0.0.1" ||
      request.url !== "/" ||
      request.headers.origin !== undefined ||
      Object.keys(request.headers).some(
        (key) => key === "forwarded" || key.startsWith("x-forwarded-"),
      )
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });
  sockets.on("connection", (socket) => {
    const nonce = randomUUID();
    let token: string | undefined;
    let inflight = false;
    const deadline = setTimeout(() => socket.terminate(), 10_000);
    const send = (value: unknown) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(value));
      }
    };
    const assertConnection = () => {
      assertCurrent();
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Maintenance coordinator disconnected");
      }
    };
    socket.on("error", () => socket.terminate());
    socket.on("close", () => clearTimeout(deadline));
    send({ type: "event", event: "connect.challenge", payload: { nonce, ts: Date.now() } });
    socket.on("message", (bytes, binary) => {
      // Never queue concurrent commands, including a second frame during authentication.
      if (inflight || binary) {
        socket.terminate();
        return;
      }
      inflight = true;
      const run = async () => {
        let id: string | undefined;
        let acquired = false;
        try {
          const frame: unknown = JSON.parse(rawDataToString(bytes));
          if (!validateRequestFrame(frame)) {
            throw new Error("Invalid maintenance request");
          }
          id = frame.id;
          assertConnection();
          if (!token) {
            if (frame.method !== "connect" || !validateConnectParams(frame.params)) {
              throw new Error("Maintenance connect required");
            }
            const credential = verifyMaintenanceCoordinatorProof(frame.params, binding, nonce);
            await operateGatewayMaintenanceRecovery(
              { generation, binding, token: credential },
              assertConnection,
            );
            assertConnection();
            token = credential;
            clearTimeout(deadline);
            send({
              type: "res",
              id,
              ok: true,
              payload: {
                type: "maintenance-hello",
                protocol: PROTOCOL_VERSION,
                maintenance: true,
                methods: [
                  "gateway.maintenance.status",
                  "gateway.maintenance.recover",
                  "gateway.maintenance.release",
                ],
              },
            });
            return;
          }
          if (
            ![
              "gateway.maintenance.status",
              "gateway.maintenance.recover",
              "gateway.maintenance.release",
            ].includes(frame.method) ||
            !validateGatewayMaintenanceGenerationParams(frame.params) ||
            frame.params.generation !== generation ||
            busy
          ) {
            throw new Error("Maintenance command refused");
          }
          busy = true;
          acquired = true;
          const input = { generation, binding, token };
          let state = await operateGatewayMaintenanceRecovery(input, assertConnection);
          assertConnection();
          const inspect = () => createGatewayActiveWorkSnapshot();
          const assertIdle = () => {
            assertConnection();
            if (!inspect().idle) {
              throw new Error("Maintenance writers have not drained");
            }
          };
          const transition = async (
            command: NonNullable<
              Parameters<typeof operateGatewayMaintenanceRecovery>[0]["command"]
            >,
            guard = assertConnection,
          ) => {
            try {
              return await operateGatewayMaintenanceRecovery({ ...input, command }, guard);
            } catch (error) {
              // A lost worker acknowledgement cannot justify retry or reopening.
              uncertain = true;
              throw error;
            }
          };
          if (frame.method === "gateway.maintenance.recover") {
            if (!["draining", "held"].includes(state.phase)) {
              throw new Error("Maintenance receipt requires reconciliation");
            }
            if (state.ownerInstanceId !== ownerInstanceId) {
              state = await transition({
                action: "recover",
                generation,
                ownerInstanceId,
                previousOwnerInstanceId: state.ownerInstanceId,
              });
            }
            if (state.phase === "draining" && inspect().idle) {
              state = await transition({ action: "hold", generation, ownerInstanceId }, assertIdle);
            }
          } else if (frame.method === "gateway.maintenance.release") {
            if (state.ownerInstanceId !== ownerInstanceId || state.phase !== "held") {
              throw new Error("Maintenance release requires this process's held generation");
            }
            state = await transition(
              { action: "release", generation, ownerInstanceId },
              assertIdle,
            );
            released = true;
            // Keep the admission hold and this control-only listener until explicit close/restart.
          }
          assertConnection();
          send({
            type: "res",
            id,
            ok: true,
            payload: {
              state,
              processOwnerInstanceId: ownerInstanceId,
              owned: state.ownerInstanceId === ownerInstanceId,
              work: inspect(),
              controlOnly: true,
              readyForEnrollment: false,
            },
          });
        } catch {
          if (id !== undefined) {
            send({
              type: "res",
              id,
              ok: false,
              error: {
                code: "UNAVAILABLE",
                message: "Maintenance request refused; inspect durable state before retry",
              },
            });
          }
          if (!token || uncertain || id === undefined) {
            socket.close(1008, "Maintenance authority refused");
          }
        } finally {
          if (acquired) {
            busy = false;
          }
          inflight = false;
        }
      };
      const pending = run();
      work.add(pending);
      void pending.finally(() => work.delete(pending));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(options.port, "127.0.0.1", () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });
    assertCurrent();
    options.onListening?.();
  } catch (error) {
    closing = true;
    for (const client of sockets.clients) {
      client.terminate();
    }
    await Promise.all(work);
    await new Promise<void>((resolve) => {
      sockets.close(() => resolve());
    });
    if (httpServer.listening) {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((failure) => (failure ? reject(failure) : resolve()));
      });
    }
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    isDurablyReleased: () => released && !uncertain,
    startupSettled: Promise.resolve(),
    getTailscaleIngressEndpoint: () => undefined,
    close: () =>
      (closePromise ??= (async () => {
        closing = true;
        for (const client of sockets.clients) {
          client.terminate();
        }
        await Promise.all(work);
        await new Promise<void>((resolve) => {
          sockets.close(() => resolve());
        });
        httpServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      })()),
  };
}
