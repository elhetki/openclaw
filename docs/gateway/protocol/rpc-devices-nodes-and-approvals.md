---
summary: "Gateway RPC families for device pairing, node invoke, approvals, Control UI commands, and automation"
read_when:
  - Pairing a device or minting a device token
  - Invoking a node or draining its pending work
  - Resolving approvals or driving Control UI commands
title: "Gateway protocol device, node, and approval methods"
sidebarTitle: "Devices, nodes, and approvals"
doc-schema-version: 1
---

RPC method families for device pairing and device tokens, node pairing and invoke, approvals, Control UI commands, and automation, skills, and tools.

## Device pairing and device tokens

- `device.pair.list` returns pending and approved paired devices.
- `device.pair.setupCode` creates a mobile setup code and, by default, a PNG QR data URL. It requires `operator.admin` and is intentionally omitted from advertised discovery. Current gateways include an opaque non-secret `setupId`, authoritative `expiresAtMs`, `setupCode`, optional `qrDataUrl`, `gatewayUrl`, the non-secret `auth` label, `urlSource`, and the issued `access` level (`full`, `limited`, or `node`). Older protocol-v4 gateways omit `setupId` and `expiresAtMs`, so separately shipped clients must treat those lifecycle fields as optional. The `setupId` is independent from the bootstrap credential and is not embedded in the setup code.
- `device.pair.setupStatus` reconciles one setup credential the caller already issued (`{ setupId }`). It requires `operator.admin`, is omitted from advertised discovery, and returns either `{ completion }` after the credential-bearing response finishes or `{ deliveryUncertain }` when the bearer was retired but response delivery could not be confirmed. Both use the same non-secret payload as their corresponding events. When both fields are absent, the gateway holds no retained outcome for that `setupId`.
- `device.pair.approve`, `device.pair.reject`, and `device.pair.remove` manage device-pairing records.
- `device.pair.rename` assigns an operator label (`{ deviceId, label }`) that is preferred over the client-reported display name and survives device repair or re-approval.
- `device.token.rotate` rotates a paired device token within its approved role and caller scope bounds.
- `device.token.revoke` revokes a paired device token within its approved role and caller scope bounds.

The setup code embeds a short-lived bootstrap credential. Clients must not
log or persist it beyond the pairing flow.

Pairing-scoped clients receive `device.pair.setup.completed` only after the
exact setup handoff has delivered its credentials. Its payload is
`{ setupId, deviceId, deviceName?, access, ts }`; it never includes the
bootstrap credential or token-derived identifiers.

If the response closes before delivery can be confirmed, the gateway keeps
the bearer retired and emits `device.pair.setup.deliveryUncertain` instead
of success. The presenting client should offer the operator a path to inspect
or remove the paired device and generate a new setup code.

The gateway records an uncertain outcome when it consumes the bearer, then
promotes it to completion only after response delivery finishes. Operator
event frames are best effort and drop for slow subscribers rather than
closing their socket. A client that displayed a setup code must therefore
call `device.pair.setupStatus` before presenting the code as expired.
Outcomes are retained past the credential's own expiry.

## Node pairing, invoke, and pending work

- `node.pair.list`, `node.pair.approve`, `node.pair.reject`, and `node.pair.remove` cover node capability approvals. `node.pair.request` and `node.pair.verify` were removed in 2026.7 together with the standalone node pairing store; pending requests are created by the Gateway during node connects.
- `node.list` and `node.describe` return known/connected node state.
- `node.admission.describe` is a privileged control-plane read for a live,
  signed device-token `operator.admin` connection. It accepts exact `nodeId` and
  `expectedGatewayDeviceId` fingerprints and returns `gatewayDeviceId` plus an
  `expectedPairing` object containing `deviceId`, `generation`, and `connectionId`.
  Internal agent, plugin, synthetic, unsigned, and non-admin callers are denied;
  this RPC is not exposed as an agent tool. The node must remain paired and on
  the same connection throughout the read. It does not pair or wake a device.
  Pass the returned object unchanged to `node.invoke`: a replaced pairing or
  connection fails before dispatch and stale results are withheld. A connection
  pin disables deferred foreground queuing; an offline node needs fresh admission.
  Ordinary `node.describe` and invocations without a pin retain their behavior.

  Nate activation requires one human per personal Gateway, an audited inventory
  of admin credentials, and broker credentials unavailable to agent processes.
  A second genuine admin credential on that installation is equivalent authority,
  not a separate tenant. These pins restrict targets; they do not grant task or
  user authority, which Nate must check independently at dispatch and result.

- `node.rename` updates a paired node label.
- `node.invoke` forwards a command to a connected node.
- Callers that admit work against a specific pairing may provide `expectedPairing: { deviceId, generation }` to `node.invoke`. `deviceId` is the canonical authenticated device fingerprint and must match `nodeId`; `generation` is the admitted node pairing generation. A mismatch returns `PAIRING_CHANGED` before wake or dispatch. The Gateway retains that generation and its selected connection through the existing transport checks. Omitting the optional precondition preserves ordinary invocation behavior. The precondition pins a target; it does not grant command permission or establish application task authority.
- `node.invoke.result` returns the result for an invoke request.
  A node may return `NODE_NOT_READY` only when lifecycle cleanup prevented
  execution, before calling a command handler or emitting progress. The
  Gateway retries this rejection up to four times within the original invoke
  deadline, rechecking the connection, pairing, and command authorization at
  each dispatch. General `UNAVAILABLE` errors, disconnects, timeouts, and
  failures after progress are not retried.
- `mcp.tools.call.v1` is the headless node-host command for calling a configured node-local MCP tool. It is carried through `node.invoke`, requires the node to declare the command, and remains subject to pairing approval and `gateway.nodes.commands.deny`.
- `node.event` carries node-originated events back into the gateway.
- `node.pluginTools.update` is the only publication path for replacing the connected node's agent-visible plugin/MCP tool descriptors; `connect` params do not carry them.
- `node.pending.pull` and `node.pending.ack` are the connected-node queue APIs.
- `node.pending.enqueue` and `node.pending.drain` manage durable pending work for offline/disconnected nodes.

## Approval families

- `approval.history` returns newest-first terminal approvals retained for 30 days for exec, plugin, and system-agent requests (scope `operator.approvals`). It supports cursor pagination plus an optional kind filter; pending approvals are not history rows. Treat each cursor as an opaque server token and return the exact value without padding, rewriting, or adding fields.
- `approval.get` and `approval.resolve` are the kind-agnostic durable approval methods (scope `operator.approvals`). `approval.get` returns a sanitized pending or retained terminal projection with a stable `urlPath`; `approval.resolve` accepts the stored approval id, an explicit `kind`, and a decision, applies first-answer-wins resolution, and always returns the recorded result.
- `exec.approval.request`, `exec.approval.get`, `exec.approval.list`, and `exec.approval.resolve` cover one-shot exec approval requests plus pending approval lookup/replay. They are protocol-boundary adapters over the same durable approval registry.
- `exec.approval.waitDecision` waits on one pending exec approval and returns the final decision (or `null` on timeout).
- `exec.approvals.get` and `exec.approvals.set` manage gateway exec approval policy snapshots.
- `exec.approvals.node.get` and `exec.approvals.node.set` manage node-local exec approval policy via node relay commands.
- `plugin.approval.request`, `plugin.approval.list`, `plugin.approval.waitDecision`, and `plugin.approval.resolve` cover plugin-defined approval flows.

Approval lookup, history, waits, and resolution retain their original device and
account authority while storage work is pending. Disconnecting the socket alone does not cancel an admitted request.
Revoking that authority before commit admission prevents the verdict and withholds
approval details; the pending approval remains available to another authorized reviewer.
A verdict that already committed remains recorded and settles its waiting action.
Resolution replies do not wait for best-effort channel or push notifications after
the decision is recorded. A slow or failed notification cannot reopen the approval
or delay acknowledgement of its verdict.

`exec.approvals.get` accepts optional `expectedOwnerId`; `exec.approvals.set`
accepts `file`, optional `baseHash`, and optional `expectedOwnerId`. Existing
snapshots require the hash returned by `get`; a stale or missing hash refuses the
save. For an absent snapshot, an omitted hash is accepted, but a supplied hash
must match. The default local CLI always carries its observed hash. Both methods
return the existing redacted snapshot (`path`, `exists`, `hash`, `file`) plus
`resolvedDefaults`; omitted socket defaults retain their existing merge behavior.

Default local CLI reads and writes negotiate their separate
[owner capabilities](/gateway/protocol/versioning#local-state-owner-routing)
and send `expectedOwnerId`. Reading participates because it can initialize missing
state. Existing RPC clients may omit the owner field; explicit Gateway and node
targets retain their current transport and response contracts. This changes no
exec policy, standing-grant, or execution-authorization semantics.

## Control UI commands

- `ui.command` lets an `operator.write` caller send typed layout and navigation commands to the requesting Control UI connection, which must advertise the `ui-commands` capability.
- Commands cover pane split/close/focus, sidebar visibility, terminal/browser panel visibility and dock, and session navigation.
- The Gateway derives the recipient from the authenticated request or the agent turn's captured browser target, never from the destination session. Other connections keep their current view. A missing or disconnected requester fails with `UNAVAILABLE`; there is no broadcast fallback.
- Standalone callers that relied on legacy broadcast delivery must initiate these actions from a Control UI connection or a turn started there. A standalone call without a browser target no longer controls connected dashboards.

## Automation, skills, and tools

- Automation: `wake` schedules an immediate or next-heartbeat wake text injection; `cron.get`, `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs` manage scheduled work.
- `cron.run` enqueues a manual run and acknowledges with `{ ok: true, enqueued: true, runId }`. Pass `waitTimeoutMs` to hold the response until that run records its outcome: the acknowledgement then also carries `run`, the same entry `cron.runs` returns for that `runId`, or `finished: true` when the run ended but its history is not visible to the caller. If the wait ends first, neither is set and the run continues. Agent-runtime callers get the plain acknowledgement immediately for main-session jobs and jobs that run in their own session, because those runs start only after the calling turn.
- `cron.runs` accepts an optional non-empty `runId` filter so clients can follow one queued manual run without racing against other history entries for the same job.
- Skills and tools: `commands.list`, `skills.*`, `tools.catalog`, `tools.effective`, `tools.invoke`. See [Operator helper methods](/gateway/protocol/operator-methods#operator-helper-methods).

## Host-owned external node authority

A Gateway host can install `externalNodeInvokeAuthority` on its request context.
This source-only hook is not an RPC field, model tool, plugin policy argument, or
configuration claim. Its provider identifies protected requests from authenticated
Gateway state and captures the current task, principal/session/role, exact command,
immutable payload, and pairing/connection binding in a closure. It must throw when
that protected binding is missing; `undefined` is reserved for ordinary callers.
No provider bootstrap or broker credentials are supplied by this protocol change.

For protected calls, a fresh `authorize("dispatch")` check runs at the registry's
existing final transport seam on every readiness retry. Local `isCurrent()` runs
again after the awaited broker check. `authorize("result")` runs before releasing
results, including to a plugin policy. Exceptions and false decisions deny; the
provider must bound its network calls and publish local revocation through
`isCurrent()`. RPC deadlines still apply. A remote check cannot retroactively undo
an already dispatched action; retain dispatch provenance when reporting a failure.

Protected calls require an admitted connection pin. Until they have their own
per-effect authority contract, progress streaming, private plugin transports,
plugin payload/workspace/idempotency overrides, and deferred foreground delivery
are denied. Ordinary calls without an external binding keep existing behavior.
Nate activation must prove its host provider is installed and that disabling or
losing the broker cannot make protected calls fall through to ordinary dispatch.
