import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { RespondFn } from "./server-methods/types.js";

/** Host-installed provider, never accepted from RPC params or plugin tool input.
 * The provider must identify protected requests from authenticated Gateway state,
 * throw when their binding is missing, and return undefined only for ordinary callers.
 */
export type ExternalNodeInvokeAuthorityProvider = (
  request: Readonly<{
    client: GatewayClient | null;
    nodeId: string;
    command: string;
    params: unknown;
    idempotencyKey: string;
    pairing: Readonly<{ deviceId: string; generation: string; connectionId: string }>;
  }>,
) => ExternalNodeInvokeAuthority | undefined;

export type ExternalNodeInvokeAuthority = Readonly<{
  /** A fresh broker check for every transport attempt and every result release. */
  authorize: (phase: "dispatch" | "result") => Promise<boolean>;
  /** Synchronous local lifetime check after any awaited broker work. */
  isCurrent: () => boolean;
}>;

export function isExternalNodeAuthorityCurrent(authority: ExternalNodeInvokeAuthority): boolean {
  try {
    return authority.isCurrent() === true;
  } catch {
    return false;
  }
}

export async function checkExternalNodeAuthority(
  authority: ExternalNodeInvokeAuthority,
  phase: "dispatch" | "result",
): Promise<boolean> {
  if (!isExternalNodeAuthorityCurrent(authority)) {
    return false;
  }
  try {
    return (await authority.authorize(phase)) === true && isExternalNodeAuthorityCurrent(authority);
  } catch {
    // Broker errors never become an allow decision or expose broker response data.
    return false;
  }
}

export function respondExternalNodeAuthorityClosed(
  respond: RespondFn,
  nodeCommandDispatched: boolean,
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, "external node authority is unavailable or closed", {
      details: { code: "EXTERNAL_AUTHORITY_CLOSED", nodeCommandDispatched },
    }),
  );
}

export function prepareExternalNodeInvokeAuthority(
  provider: ExternalNodeInvokeAuthorityProvider | undefined,
  request: Parameters<ExternalNodeInvokeAuthorityProvider>[0],
): { authority: ExternalNodeInvokeAuthority | undefined; params: unknown } {
  if (!provider) {
    return { authority: undefined, params: request.params };
  }
  const snapshot = freezeJsonSnapshot(structuredClone(request.params));
  const authority = provider({ ...request, params: snapshot });
  return { authority, params: authority ? snapshot : request.params };
}
