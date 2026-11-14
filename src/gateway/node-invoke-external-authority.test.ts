import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import {
  createContext,
  createDemoPolicy,
  createNodeSession,
  DEMO_COMMAND,
  DEMO_PARAMS,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";

afterEach(() => resetPluginRuntimeStateForTest());
describe("external authority through plugin node transport", () => {
  it.each(["allowed", "broker-offline", "revoked", "result-denied", "override"])(
    "retains authority at plugin transport (%s)",
    async (outcome) => {
      let live = true;
      let sent = false;
      setDangerousDemoCommandRegistry([
        createDemoPolicy((ctx) =>
          ctx.invokeNode(outcome === "override" ? { params: { changed: true } } : {}),
        ),
      ]);
      const { context, invoke } = createContext();
      const authorize = vi.fn(async (phase: "dispatch" | "result") => {
        if (outcome === "broker-offline") {
          throw new Error("broker unreachable");
        }
        if (outcome === "revoked") {
          live = false;
        }
        return phase !== "result" || outcome !== "result-denied";
      });
      invoke.mockImplementation(async (request) => {
        if (!(await request.authorizeDispatch?.()) || !request.isDispatchAuthorized?.()) {
          return { ok: false, error: { code: "APPROVAL_AUTHORITY_CLOSED" } };
        }
        sent = true;
        return { ok: true, payload: { screenshot: "private" } };
      });
      const result = await applyPluginNodeInvokePolicy({
        context,
        client: null,
        nodeSession: createNodeSession(),
        command: DEMO_COMMAND,
        params: DEMO_PARAMS,
        externalAuthority: { authorize, isCurrent: () => live },
      });
      expect(result?.ok).toBe(outcome === "allowed");
      if (["broker-offline", "revoked", "override"].includes(outcome)) {
        expect(sent).toBe(false);
      }
      if (outcome === "result-denied") {
        expect(JSON.stringify(result)).not.toContain("screenshot");
      }
      if (outcome === "allowed") {
        expect(authorize.mock.calls).toEqual([["dispatch"], ["result"]]);
      }
    },
  );
});
