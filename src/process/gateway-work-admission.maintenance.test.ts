import { expect, it } from "vitest";
import {
  holdGatewayMaintenanceAdmission,
  isGatewayWorkAdmissionClosed,
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewayIndependentRootWorkAdmission,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRestartStartupRootWorkAdmission,
  markGatewayRestartDraining,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";

it("keeps maintenance closed through suspension and lifecycle reset while accepted work drains", async () => {
  resetGatewayWorkAdmission();
  const prior = tryBeginGatewayRootWorkAdmission("accepted-before-maintenance");
  expect(prior).not.toBeNull();
  const hold = holdGatewayMaintenanceAdmission();
  try {
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
    expect(tryBeginGatewayRootWorkAdmission("chat.send")).toBeNull();
    expect(tryBeginGatewayIndependentRootWorkAdmission("cron")).toBeNull();
    expect(tryBeginGatewaySuspendAdmission(() => {})).toBeNull();
    expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
    await prior!.run(async () => {
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
      expect(tryBeginGatewayRootWorkAdmission("accepted-continuation")?.ownsRoot).toBe(false);
    });
    prior!.release();
    markGatewayRestartDraining();
    expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();
    resetGatewayWorkAdmission();
    hold.assertCurrent();
    expect(tryBeginGatewayRootWorkAdmission("after-reset")).toBeNull();
    expect(() => holdGatewayMaintenanceAdmission()).toThrow();
  } finally {
    prior?.release();
    hold.release();
    resetGatewayWorkAdmission();
  }
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
  expect(() => hold.release()).toThrow();
});
