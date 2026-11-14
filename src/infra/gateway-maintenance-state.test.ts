import { describe, expect, it } from "vitest";
import {
  parseGatewayMaintenanceState,
  transitionGatewayMaintenance,
  type GatewayMaintenanceCommand,
} from "./gateway-maintenance-state.js";

const owner = "00000000-0000-4000-8000-000000000001";
const nextOwner = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const begin: GatewayMaintenanceCommand = {
  action: "begin",
  ownerInstanceId: owner,
  requestId,
  binding: {
    deviceId: "a".repeat(64),
    publicKey: "b".repeat(43),
    agentId: "fixture",
    sessionKey: "agent:fixture:direct:fixture",
  },
};
const command = (action: "hold" | "enroll" | "release") => ({
  action,
  generation: 1,
  ownerInstanceId: owner,
});

describe("persistent maintenance state", () => {
  it("never treats malformed persisted authority as disabled", () => {
    expect(parseGatewayMaintenanceState(undefined)).toBeUndefined();
    for (const value of [
      null,
      {},
      { version: 2 },
      { ...transitionGatewayMaintenance(undefined, begin), phase: "enrolled" },
    ]) {
      expect(() => parseGatewayMaintenanceState(value)).toThrow(/reconciliation/);
    }
  });

  it("retains the generation and binding on retry and rejects other owners", () => {
    const state = transitionGatewayMaintenance(undefined, begin);
    expect(state.phase).toBe("draining");
    expect(transitionGatewayMaintenance(state, begin)).toEqual(state);
    expect(() =>
      transitionGatewayMaintenance(state, { ...begin, ownerInstanceId: nextOwner }),
    ).toThrow();
    expect(() =>
      transitionGatewayMaintenance(state, { ...command("hold"), generation: 2 }),
    ).toThrow();
    expect(() => transitionGatewayMaintenance(state, command("release"))).toThrow();
  });

  it("requires re-drain after process replacement and fences old ownership", () => {
    const held = transitionGatewayMaintenance(
      transitionGatewayMaintenance(undefined, begin),
      command("hold"),
    );
    const recovered = transitionGatewayMaintenance(held, {
      action: "recover",
      generation: 1,
      previousOwnerInstanceId: owner,
      ownerInstanceId: nextOwner,
    });
    expect(recovered.phase).toBe("draining");
    expect(() => transitionGatewayMaintenance(recovered, command("enroll"))).toThrow();
    expect(() =>
      transitionGatewayMaintenance(recovered, { ...command("enroll"), ownerInstanceId: nextOwner }),
    ).toThrow();
  });

  it("an uncertain enrollment cannot retry, release, recover or silently adopt", () => {
    const held = transitionGatewayMaintenance(
      transitionGatewayMaintenance(undefined, begin),
      command("hold"),
    );
    const pending = transitionGatewayMaintenance(held, command("enroll"));
    expect(transitionGatewayMaintenance(pending, begin)).toEqual(pending);
    for (const action of ["hold", "enroll", "release"] as const) {
      expect(() => transitionGatewayMaintenance(pending, command(action))).toThrow();
    }
    expect(() =>
      transitionGatewayMaintenance(pending, {
        action: "recover",
        generation: 1,
        previousOwnerInstanceId: owner,
        ownerInstanceId: nextOwner,
      }),
    ).toThrow();
  });

  it("records the exact receipt and never reuses a released generation", () => {
    let state = transitionGatewayMaintenance(undefined, begin);
    state = transitionGatewayMaintenance(state, command("hold"));
    state = transitionGatewayMaintenance(state, command("enroll"));
    state = transitionGatewayMaintenance(state, {
      action: "confirm",
      generation: 1,
      ownerInstanceId: owner,
      receipt: { sessionId: requestId, lifecycleRevision: nextOwner },
    });
    expect(state.receipt).toEqual({ sessionId: requestId, lifecycleRevision: nextOwner });
    state = transitionGatewayMaintenance(state, command("release"));
    expect(() => transitionGatewayMaintenance(state, begin)).toThrow();
    const next = transitionGatewayMaintenance(state, { ...begin, requestId: nextOwner });
    expect(next.generation).toBe(2);
    expect(next.receipt).toBeUndefined();
  });
});
