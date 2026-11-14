import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const gatewayMaintenanceStateKey = "gateway.maintenance.v1";

export type GatewayMaintenanceBinding = {
  deviceId: string;
  publicKey: string;
  tokenIdentityKey: string;
  agentId: string;
  sessionKey: string;
};

export type GatewayMaintenanceReceipt = {
  sessionId: string;
  lifecycleRevision: string;
};

export type GatewayMaintenanceEnrollment = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  tokenIdentityKey: string;
  planned: GatewayMaintenanceReceipt;
};

export type GatewayMaintenanceState = {
  version: 2;
  generation: number;
  requestId: string;
  ownerInstanceId: string;
  binding: GatewayMaintenanceBinding;
  phase: "draining" | "held" | "enrollment_pending" | "enrolled" | "released";
  receipt?: GatewayMaintenanceReceipt;
  enrollment?: GatewayMaintenanceEnrollment;
};

export type GatewayMaintenanceCommand =
  | {
      action: "prepare-enrollment";
      generation: number;
      ownerInstanceId: string;
      enrollment: GatewayMaintenanceEnrollment;
    }
  | {
      action: "recover-enrollment";
      generation: number;
      ownerInstanceId: string;
      previousOwnerInstanceId: string;
    }
  | {
      action: "begin";
      requestId: string;
      ownerInstanceId: string;
      binding: GatewayMaintenanceBinding;
    }
  | {
      action: "recover";
      generation: number;
      ownerInstanceId: string;
      previousOwnerInstanceId: string;
    }
  | {
      action: "hold" | "enroll" | "release";
      generation: number;
      ownerInstanceId: string;
    }
  | {
      action: "confirm";
      generation: number;
      ownerInstanceId: string;
      receipt: GatewayMaintenanceReceipt;
    };

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fail = (): never => {
  throw new Error("Gateway maintenance requires reconciliation");
};

function binding(value: unknown): value is GatewayMaintenanceBinding {
  return (
    isRecord(value) &&
    typeof value.deviceId === "string" &&
    /^[a-f0-9]{64}$/.test(value.deviceId) &&
    typeof value.publicKey === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.publicKey) &&
    typeof value.tokenIdentityKey === "string" &&
    /^[a-f0-9]{64}$/.test(value.tokenIdentityKey) &&
    typeof value.agentId === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value.agentId) &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length <= 512 &&
    value.sessionKey.startsWith(`agent:${value.agentId}:`) &&
    !/[\s\p{Cc}\p{Cf}]/u.test(value.sessionKey)
  );
}

function receipt(value: unknown): value is GatewayMaintenanceReceipt {
  return isRecord(value) && uuid(value.sessionId) && uuid(value.lifecycleRevision);
}

function enrollment(value: unknown): value is GatewayMaintenanceEnrollment {
  return (
    isRecord(value) &&
    uuid(value.requestId) &&
    typeof value.deviceId === "string" &&
    /^[a-f0-9]{64}$/.test(value.deviceId) &&
    typeof value.publicKey === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.publicKey) &&
    typeof value.tokenIdentityKey === "string" &&
    /^[a-f0-9]{64}$/.test(value.tokenIdentityKey) &&
    receipt(value.planned)
  );
}

function sameReceipt(a: GatewayMaintenanceReceipt, b: GatewayMaintenanceReceipt): boolean {
  return a.sessionId === b.sessionId && a.lifecycleRevision === b.lifecycleRevision;
}

/** Missing state means never enabled. Malformed persisted state must never reopen admission. */
export function parseGatewayMaintenanceState(value: unknown): GatewayMaintenanceState | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    !uuid(value.requestId) ||
    !uuid(value.ownerInstanceId) ||
    !binding(value.binding) ||
    !["draining", "held", "enrollment_pending", "enrolled", "released"].includes(
      String(value.phase),
    ) ||
    (value.receipt !== undefined && !receipt(value.receipt)) ||
    (value.phase === "enrolled" && value.receipt === undefined) ||
    (!["enrolled", "released"].includes(String(value.phase)) && value.receipt !== undefined) ||
    (value.enrollment !== undefined &&
      (!enrollment(value.enrollment) ||
        !["enrollment_pending", "enrolled", "released"].includes(String(value.phase)) ||
        value.enrollment.deviceId === value.binding.deviceId ||
        (value.receipt !== undefined && !sameReceipt(value.receipt, value.enrollment.planned))))
  ) {
    return fail();
  }
  return value as GatewayMaintenanceState;
}

function sameBinding(a: GatewayMaintenanceBinding, b: GatewayMaintenanceBinding): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.publicKey === b.publicKey &&
    a.tokenIdentityKey === b.tokenIdentityKey &&
    a.agentId === b.agentId &&
    a.sessionKey === b.sessionKey
  );
}

/** Run only inside the shared-state owner's write transaction. No timers or expiry reopen it.
 * These are internal state transitions, not RPC authorization. The runtime must own the
 * drain/creation commit guards before asking the worker to record their result. */
export function transitionGatewayMaintenance(
  value: unknown,
  command: GatewayMaintenanceCommand,
): GatewayMaintenanceState {
  const current = parseGatewayMaintenanceState(value);
  if (!uuid(command.ownerInstanceId)) {
    return fail();
  }
  if (command.action === "begin") {
    if (!uuid(command.requestId) || !binding(command.binding)) {
      return fail();
    }
    if (current && current.phase !== "released") {
      if (
        current.requestId !== command.requestId ||
        !sameBinding(current.binding, command.binding) ||
        current.ownerInstanceId !== command.ownerInstanceId
      ) {
        return fail();
      }
      return current;
    }
    // A completed generation is never silently recreated under its old request ID.
    if (
      current?.requestId === command.requestId ||
      current?.generation === Number.MAX_SAFE_INTEGER
    ) {
      return fail();
    }
    return {
      version: 2,
      generation: (current?.generation ?? 0) + 1,
      requestId: command.requestId,
      ownerInstanceId: command.ownerInstanceId,
      binding: { ...command.binding },
      phase: "draining",
    };
  }
  if (!current || current.generation !== command.generation || current.phase === "released") {
    return fail();
  }
  if (command.action === "recover-enrollment") {
    if (
      !current.enrollment ||
      !["enrollment_pending", "enrolled"].includes(current.phase) ||
      current.ownerInstanceId !== command.previousOwnerInstanceId ||
      current.ownerInstanceId === command.ownerInstanceId
    ) {
      return fail();
    }
    // Preserve pending effects/receipt. This grants reconciliation ownership,
    // never a new session identity or an implicit completion/release.
    return { ...current, ownerInstanceId: command.ownerInstanceId };
  }
  if (command.action === "recover") {
    if (
      current.ownerInstanceId !== command.previousOwnerInstanceId ||
      current.ownerInstanceId === command.ownerInstanceId ||
      current.phase === "enrollment_pending"
    ) {
      return fail();
    }
    // Every new process must drain again. A retained enrollment receipt is recovered
    // through explicit inspection, never through another sessions.create call.
    if (current.phase === "enrolled") {
      return fail();
    }
    return { ...current, ownerInstanceId: command.ownerInstanceId, phase: "draining" };
  }
  if (current.ownerInstanceId !== command.ownerInstanceId) {
    return fail();
  }
  if (command.action === "hold" && current.phase === "draining") {
    return { ...current, phase: "held" };
  }
  if (
    command.action === "prepare-enrollment" &&
    current.phase === "held" &&
    enrollment(command.enrollment) &&
    command.enrollment.deviceId !== current.binding.deviceId
  ) {
    return {
      ...current,
      phase: "enrollment_pending",
      enrollment: structuredClone(command.enrollment),
    };
  }
  if (command.action === "enroll" && current.phase === "held") {
    return { ...current, phase: "enrollment_pending" };
  }
  if (
    command.action === "confirm" &&
    current.phase === "enrollment_pending" &&
    receipt(command.receipt) &&
    (!current.enrollment || sameReceipt(command.receipt, current.enrollment.planned))
  ) {
    return { ...current, phase: "enrolled", receipt: { ...command.receipt } };
  }
  if (command.action === "release" && (current.phase === "held" || current.phase === "enrolled")) {
    return { ...current, phase: "released" };
  }
  return fail();
}
