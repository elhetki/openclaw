# Nate maintenance prototype checkpoint

This is an incomplete source prototype, not an activation-ready Gateway build.
No VM, Nate checkout, database, bot, browser, or external ingress was changed.

Base: official `openclaw/openclaw` tag `v2026.11.3`, commit
`847611dcaa3bf0e2783335f961dd1fd0580e4d9f`.
Branch: `nate/persistent-maintenance-20261114`.
Foundation checkpoint: `46535ee8`.

## Implemented

- Durable generation, owner-instance and exact target/device binding records in
  existing `config_machine_state`, through the shared-state writer transaction.
  No schema migration or JSON sidecar.
- Missing state is disabled; malformed state fails closed. No expiry. Stale owners,
  conflicting replays and uncertain enrollment retries are refused. A pending
  enrollment cannot release or recover automatically.
- An admission capability rejects ordinary/independent roots and restart
  exceptions while existing admitted work can finish. Runtime reset does not clear
  it. The explicit maintenance RPC controller acquires this capability.
- Ordinary bootstrap refuses an active/malformed maintenance marker before session
  migrations, plugin bootstrap and channel/scheduler startup. This is a refusal,
  not a restored control-only server. Existing startup maintenance handling parks
  managed launchd and uses exit 78 for systemd policy; guidance preserves the marker.
- `gateway.maintenance.prepare/status/release` now bind an existing authenticated
  local operator device-token connection, exact token identity, and target. They
  pause scheduling, inspect the complete existing work/custody inventory, persist
  draining/held/released transitions, and guard worker commits. General session
  creation and transient suspension controls cannot cross the held admission.
  No connection/restart recovery or enrollment RPC is implemented yet.
- Marker payload v2 adds the exact authenticated token identity key. The storage
  key remains unchanged so source-only v1 markers are found and fail closed;
  they are never silently treated as disabled or adopted under a successor token.

## Proof executed

- Foundation: 101 tests across maintenance state/store, work admission and suspension
  suites passed (37.55 s including cold worker preparation). The additional
  restart-startup guard passed 41 affected tests (2.83 s).
- Real native subprocess fixture uses the host writer broker, verifies revoked
  precommit authority, closes/reopens state, and rejects actual bootstrap with an
  active marker and then malformed persisted state. Final run passed in 20.64 s.
- Normal minimal Gateway bootstrap/restart and schema-refusal siblings passed:
  five tests with the first startup patch (50.66 s including cold compilation).
- After adding coordinator-specific parking: four tests passed (36.26 s); these
  include exit 78/parking without doctor recovery advice and existing schema cases.
- Targeted production typecheck, oxlint and formatting passed. Broad test type
  qualification is not claimed: the changed-path selector expanded into 28 graphs
  and was interrupted instead of treating an unbounded check as targeted proof.
- Upstream autoreview reported scoped-clean P0–P2 for the foundation and for the
  startup delta with full bootstrap/store context. It used the bundled native
  Codex CLI through the helper's supported `--codex-bin`; isolation was retained.
- Runtime RPC proof: native real-dispatcher/SQLite fixture plus admission and
  suspension siblings passed (30 tests, 28.21 s); protocol siblings passed
  (11 tests, 11.38 s). After the exact-token repair, state/store/runtime fixtures
  passed (7 tests, 20.74 s), and targeted production typecheck/lint passed.
  The fixture explicitly constructs transport attestations: it does not prove a
  public WebSocket handshake. Review found a P2 successor-token takeover, which
  was repaired and regression-tested; the follow-up review was scoped-clean P0–P2.

## Recovery transaction checkpoint

The internal `gatewayMaintenance.recovery` worker operation now rechecks the
stored generation, every binding field, the exact current paired operator token,
its approved admin ceiling, and any shared-auth issuer generation inside the
same transaction as recovery/hold/release. Status uses the same authority check.
It never adopts successor credentials and refuses mutations of pending/enrolled
receipts. This is an internal owner primitive, not a public authenticator: callers
must first prove device key/token possession and retain live transport authority.
No recovery listener or startup bypass is installed by this checkpoint.

A native host-writer fixture uses real pairing approval/token rotation/revocation
and SQLite reopen. It covers stale target/generation/owner, precommit transport
revocation, explicit recover/hold/release, pending/enrolled refusal, token
replacement, issuer generation, and approved-scope removal. State/store/recovery
siblings passed 7 tests (25.35 s); the expanded recovery fixture subsequently
passed (9.65 s). The independent review and type evidence belong to the commit
report; no public WebSocket or restart-recovery success is claimed.

## Manifest policy contract checkpoint

Plugins can explicitly consent to the separate core coordinator context using
`"gatewayMaintenance": { "policy": "core-coordinator-v1" }`. The manifest parser
rejects unknown versions and extra keys before loading plugin JavaScript. The
version fixes the permitted recovery methods to status/recover/enroll/release;
it does not permit ordinary `sessions.create`. Normal plugin registration rejects
an access-policy callback from a plugin declaring this consent.

The metadata admission primitive refuses missing or scoped inventories, unknown
plugins, configured Gateway roles, implicit/custom memory slots, and custom
context engines. The initial supported configuration requires `memory: "none"`.
Review found two real activation gaps: slot owners and dreaming sidecars can
bypass the ordinary allowlist. The explicit slot restriction closes both instead
of duplicating the runtime activation planner. This primitive is not yet wired
into startup, so it does not enable recovery or prove drain/authentication.

The final scoped autoreview reported no P0–P2 findings after those repairs.
Contract plus manifest-backup tests passed 34 tests; supported Node 26.1.0 ran
22 contract/state/store/runtime/recovery tests successfully (58.94 s). Targeted
production typecheck and lint passed on Node 26.1.0. The earlier Node 25.9.0 full
build correctly failed at the final CLI metadata step because that unsupported
runtime truncates SQLite TEXT at embedded NUL; its guard was not bypassed.
The full canonical build passed on Node 26.1.0 in 16m 24.4s, including 98 bundled
plugins, all 155 public SDK exports, declaration budget, UI budgets, and final CLI
startup metadata. This validates compilation/assets, not a recovery listener or
an immutable final package; final packaging must refresh source provenance.

The bundled OpenRouter manifest now explicitly consents in a separate reviewed
change. Its actual registration test confirms no competing access policy, and the
normal-loader conflict regression covers both ordinary and OpenRouter IDs.
The focused suites passed 59 tests on Node 26.1.0 (43.22 s); independent review
found no P0–P2 defects. Nate's native declaration was subsequently read-only
validated by the actual manifest loader; that does not qualify installed runtime.
Nate must
also retain a separate root-held coordinator credential; the Home/broker admin
credential is not maintenance authority. No TEST activation is qualified.

## Cold control and first-install checkpoint

This source checkpoint remains **not ready for enrollment or TEST activation**.
It adds a lean foreground `gateway maintenance-run --port <port>` entry, selected
before ordinary Gateway resources, and explicit offline
`gateway maintenance-bootstrap --request-stdin`. Both skip ordinary CLI config
repair/plugin loading and acquire real exclusive canonical state ownership.
Ordinary Gateway CLI preflight refuses an active durable maintenance intent.

The cold runtime admits only complete, consenting manifest metadata, watches
configuration for invalidation, and loads no plugin JavaScript. It binds only
127.0.0.1, returns HTTP 503 for all ordinary requests, rejects browser Origin and
forwarding headers, and provides no ordinary session/device RPC. Config change,
unreadable state, authority loss, or uncertain worker commit never enables normal
startup. Release persists state but leaves the admission hold and control-only
listener until explicit process termination. A fresh normal process is required.

### Host bootstrap contract

Export: `bootstrapGatewayMaintenanceOffline(value)` in
`src/gateway/maintenance-bootstrap.ts`. The explicit CLI accepts at most 8192
stdin bytes within 10 seconds; stdin and stdout must be pipes or sockets. This
checks descriptor type, not pipe ownership: the root launcher must create and
retain private pipes and never route the receipt to logs or Home/broker.

Input has exactly six fields:
`{requestId, agentId, sessionKey, publicKey, signedAt, signature}`. Request ID is a
UUID, agent/session must be exact canonical targets, public key is raw Ed25519
base64url (43 characters), signedAt is epoch milliseconds within 120 seconds,
and signature is Ed25519 base64url (86 characters). Sign the UTF-8 JSON produced
by `buildGatewayMaintenanceBootstrapPayload`:

```text
["openclaw-maintenance-bootstrap-v1", requestId, agentId, sessionKey, publicKey, signedAt]
```

Root must persist its request/key/target journal and fence ordinary services,
foreign writers, and config before launching the principal-UID one-shot. Root
sends only public key and signed request; the private signing key never leaves
root custody. Pairing, token issuance, and the draining intent share one canonical
SQLite transaction. Receipt:
`{version:1, state, credential:{deviceId,publicKey,role:"operator",token}}`.
`state` is the exact version-2 maintenance state with generation, requestId,
ownerInstanceId, binding (including tokenIdentityKey), and phase `draining`.
The token persists canonically in principal state; the root-only signing key is
the maintenance authorization boundary. Keep that key distinct from Home/broker.

If acknowledgment is lost, preserve the journal and retry the same request ID,
key, agent, and session with a fresh signed timestamp. Only an unchanged draining
receipt and exact current credential reconcile. A different request/key/target,
rotated credential, held/pending/enrolled/released phase, or pre-existing device
refuses; never guess success or generate a replacement key. This is deliberately
first-install-only. It cannot initialize another generation after release.
Earlier normal-runtime `gateway.maintenance.prepare` source exists, but the
complete later-generation operational flow is not qualified by this checkpoint
and stays unavailable for TEST integration.

### Cold wire contract

Connect to `ws://127.0.0.1:<port>/` without Origin/forwarding headers. Server sends
`{type:"event",event:"connect.challenge",payload:{nonce,ts}}`. Send the canonical
request frame `{type:"req",id,method:"connect",params}` with protocol range
including 4; client id/mode `cli`; role `operator`; scopes exactly
`["operator.admin"]`; auth exactly `{deviceToken:token}`; and device
`{id,publicKey,signature,signedAt,nonce}`. Sign the canonical v3 payload built by
`packages/gateway-client/src/device-auth.ts:buildDeviceAuthPayloadV3`, using the
same client/platform, token, scopes, nonce and timestamp. Device identity must
match the durable coordinator; signature freshness window is 120 seconds.
Current paired token, approval identity and issuer are checked inside the state
transaction on connect and every command.

Successful connect payload is
`{type:"maintenance-hello",protocol:4,maintenance:true,methods:[...]}`;
it is intentionally not the ordinary Gateway hello. Only
`gateway.maintenance.status`, `gateway.maintenance.recover`, and
`gateway.maintenance.release` exist. Each accepts exactly `{generation}`.
Replies use canonical `{type:"res",id,ok,payload}`; command payload contains
`{state,processOwnerInstanceId,owned,work,controlOnly:true,readyForEnrollment:false}`.
Status does not acquire ownership. After restart, even durable held state requires
explicit recover by the signed owner before release. Recover drains the cold
runtime and moves state to held. Do not equate cold `work.idle` with a foreign OS
writer fence. Release only accepts this process's held generation and never
starts normal machinery. Mutation uncertainty latches closure; restart and
explicit state reconciliation are required. No enrollment method is advertised.

### Verification and remaining risks

Supported Node 26.1.0 passed the real public-server entry, separate-process lean
restart, non-loopback config refusal and unconsenting-plugin refusal scenarios
(4 tests, 61.82 seconds). They prove signed challenge admission, ordinary RPC
refusal, exact-generation recovery, old-owner release refusal, release without
automatic resume, no plugin JS, and durable intent preservation on config/policy
refusal. CLI startup policy passed 11 tests; config preflight and default-off
registration siblings passed 37 tests. Atomic bootstrap rollback and lost-reply
reopen/retry passed (9.73 seconds); the lost reply is simulated by discarding a
committed result and reopening state, not by interrupting an installed host pipe.

Autoreview examined the frozen local delta and owner context with Sol medium.
It reported one P2 suggesting bootstrap reuse after release. Declined: that would
expand the approved first-install-only authority; refusal is intentional and has
a regression assertion. No P0/P1 findings were reported. The helper excluded
`pairing-token.ts` as a sensitive filename, so this is an explicit independent
review coverage limit, not an unconditional clean report. Local inspection finds
blank rejection followed by canonical `safeEqualSecret`, which compares padded
UTF-8 buffers with Node `timingSafeEqual` and requires equal original lengths.
The recovery worker fixture rejects wrong tokens and revoked/changed identities
(6.56 seconds). The final bootstrap fixture also proves refused reissue after
release (10.65 seconds). All touched TypeScript passed lint and the core typecheck.
Canonical Node 26.1.0 build passed in 2m 6.9s; the final diagnostic-text head
passed again in 2m 2.3s, including SDK declarations, CLI
bootstrap imports, UI budgets and final CLI metadata. This is source/build proof,
not an immutable final package or installed command qualification.

Remaining activation blockers (P1-level safety boundaries):

- Home device pairing and exact physical Home session creation are unimplemented
  in the cold transport. Separate shared-state/session databases require durable
  owner-only steps, exact absence CAS, physical sessionId/lifecycle receipts,
  lost-ack reconciliation and no release while incomplete. Never substitute
  ordinary `device.pair`, `sessions.resolve`, or `sessions.create`.
- No installed Linux command/package/UID/pipe qualification, resource-capacity
  qualification, host foreign-writer fence, SQL control-off attestation, or
  candidate Home/broker/socket/session/approval proof is supplied here.
- Native cold-function tests and CLI policy/registration tests do not by themselves
  qualify the final packaged CLI startup path. Final build, immutable dependency
  closure, provenance/inventory validation and installed command tests remain.
- Config observation invalidates on the canonical watcher signal; host custody
  must prevent unauthorized config replacement during this root transaction.
- Arbitrary same-UID direct DB writers are outside the Gateway lock/admission
  boundary. No timer, metadata flag or fabricated boolean fills that gap.

## External custody gap

Gateway admission is not an OS fence. The pinned upstream itself warns in
`src/gateway/server-startup-log.ts` that older CLI/SDK versions can bypass Gateway
mutation routing. A foreign process with the same database filesystem authority
can mutate state outside this process. The kernel also acquires metadata/cache
maintenance resources before ordinary bootstrap; this checkpoint does not claim
to prohibit every filesystem write during startup.

Nate still needs a host-enforced lifecycle/UID/filesystem custody arrangement that
holds foreign writers and ordinary ingress for the whole enrollment transaction,
plus SQL control-off and candidate Home/broker/socket/session/approval checks.
Neither this checkpoint nor unit tests supply those deployment attestations.
Do not enable pairing or populate approvals from this prototype.
