import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodeAdmissionHandlers } from "./nodes.admission.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(() => ({ deviceId: "gateway-a" })),
  capture: vi.fn(async () => ({ nodeId: "mac", key: "generation-1" })),
  current: vi.fn(async () => true),
}));
vi.mock("../../infra/device-identity.js", () => ({ loadDeviceIdentityIfPresent: mocks.identity }));
vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: mocks.capture,
  isNodePairingGenerationCurrent: mocks.current,
}));
beforeEach(() => vi.resetAllMocks());
function operator(): GatewayClient {
  return {
    connect: { role: "operator", scopes: ["operator.admin"], device: { id: "broker" } },
    connId: "broker-connection",
    connectionSignal: new AbortController().signal,
    isDeviceTokenAuth: true,
    internal: {
      authenticatedOperator: true,
      operatorDeviceTokenIdentity: { deviceId: "broker", key: "token-1" },
    },
  } as GatewayClient;
}
function fixture(client: GatewayClient | null = operator(), expectedGatewayDeviceId = "gateway-a") {
  const respond = vi.fn();
  const node = {
    nodeId: "mac",
    connId: "connection-1",
    pairingGeneration: "generation-1",
    client: { invalidated: false },
  };
  const get = vi.fn(() => node);
  return {
    respond,
    node,
    get,
    run: () =>
      nodeAdmissionHandlers["node.admission.describe"]!({
        req: { type: "req", id: "admission", method: "node.admission.describe" },
        params: { nodeId: "mac", expectedGatewayDeviceId },
        client,
        respond,
        context: { nodeRegistry: { getForPairingGeneration: get } },
      } as unknown as GatewayRequestHandlerOptions),
  };
}
describe("node admission describe", () => {
  it("returns a pin only to the signed admin operator on the exact installation", async () => {
    const f = fixture();
    await f.run();
    expect(f.respond).toHaveBeenCalledWith(
      true,
      {
        gatewayDeviceId: "gateway-a",
        expectedPairing: {
          deviceId: "mac",
          generation: "generation-1",
          connectionId: "connection-1",
        },
      },
      undefined,
    );
  });
  it.each([
    "anonymous",
    "member",
    "node",
    "unsigned",
    "synthetic",
    "agent",
    "plugin",
    "invalidated",
    "disconnected",
  ])("denies %s before reading identities", async (kind) => {
    let client: GatewayClient | null = operator();
    if (kind === "anonymous") {
      client = null;
    } else if (kind === "member") {
      client.connect.scopes = ["operator.read"];
    } else if (kind === "node") {
      client.connect.role = "node";
    } else if (kind === "unsigned") {
      client.isDeviceTokenAuth = false;
    } else if (kind === "synthetic") {
      client.internal!.syntheticClient = true;
    } else if (kind === "agent") {
      Object.assign(client.internal!, { agentRuntimeIdentity: {} });
    } else if (kind === "plugin") {
      client.internal!.pluginRuntimeOwnerId = "plugin";
    } else if (kind === "invalidated") {
      client.invalidated = true;
    } else {
      const c = new AbortController();
      c.abort();
      client.connectionSignal = c.signal;
    }
    const f = fixture(client);
    await f.run();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("denies a sibling installation without revealing the node", async () => {
    const f = fixture(operator(), "gateway-b");
    await f.run();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("rejects connection replacement during admission", async () => {
    const f = fixture();
    mocks.current.mockImplementationOnce(async () => {
      f.get.mockReturnValue({ ...f.node, connId: "replacement" });
      return true;
    });
    await f.run();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
  });
  it("rejects revoked pairing during admission", async () => {
    mocks.current.mockResolvedValueOnce(false);
    const f = fixture();
    await f.run();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
  });
  it("rejects caller invalidation while checking the node", async () => {
    const client = operator();
    const f = fixture(client);
    mocks.current.mockImplementationOnce(async () => {
      client.invalidated = true;
      return true;
    });
    await f.run();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
  });
});
