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

## Owner-only Home enrollment checkpoint

This extends the cold-runtime checkpoint with two durable enrollment steps. It
still reports `readyForEnrollment:false`: no immutable package, installed TEST
command, host writer fence, or resource-capacity qualification is supplied here.
The earlier statement that Home enrollment is unimplemented is superseded by
this section. TEST activation and approval publication remain unavailable.

The canonical session writer now offers `requireAbsent:true` through
`createSessionEntryWithTranscript`. It refuses native/incognito fallback and
checks physical session nodes, bounded canonical/alias keys, current physical
IDs and retained transcript windows inside the write transaction, before header
initialization. A transcript-only placeholder is occupied. Default ordinary
creation semantics are unchanged. This separate reviewed change is `3962aaf7`
(cherry-picked from `ddd2e96f`); 20 native worker tests, type/lint and P0–P2
independent review passed.

### Exact enrollment wire contract

Use the existing root coordinator's signed v3 connection; never use the Home
identity to call maintenance. The manifest-consented method is
`gateway.maintenance.enroll`, with this closed params shape:

```text
{generation, stage:"device"|"session", requestId, homePublicKey, agentId, sessionKey}
```

`requestId` is a UUID journaled by root for this enrollment; it is distinct in
meaning from the bootstrap intent's `state.requestId` (it may use the same UUID).
`homePublicKey` is raw Ed25519 base64url, 43 characters, for a new device distinct
from the coordinator. Root supplies no Home private key. The exact canonical
agent/session must equal the durable generation binding. Both stages and all
retries use exactly the same enrollment request ID, key and target.

Device stage requires this process's held generation and an absent Home device.
It approves the separate Home operator/admin credential (CLI client/mode, Linux)
and records `enrollment_pending` plus planned physical IDs in the same shared
SQLite transaction. It returns a secret receipt only on the root connection:

```text
{
  version:1,
  state,
  credential:{deviceId,publicKey,role:"operator",token},
  planned:{sessionId,lifecycleRevision},
  processOwnerInstanceId, owned:true, controlOnly:true,
  readyForEnrollment:false
}
```

`state.enrollment` contains
`{requestId,deviceId,publicKey,tokenIdentityKey,planned}`. The generation's original
coordinator binding is unchanged. Planned IDs are not evidence of physical
creation. Root keeps this entire receipt in its private journal; it must not
publish credentials to Home/broker or populate approvals at this stage.
An exact device-stage retry after enrollment also returns the existing final
`receipt`; receipt presence follows authoritative state, not the requested stage.

Session stage uses true physical absence CAS to create the exact planned session
and header. If an earlier attempt already committed it, the stage accepts only
the same key/sessionId/lifecycleRevision, no active writer, matching transcript
header/session, a real transcript generation with `maxSeq:0`, and no message.
It then confirms the physical receipt in shared state. Response has the same
fields plus `receipt:{sessionId,lifecycleRevision}`; `state.phase` is `enrolled`
and `state.receipt` is identical. A different existing session or retained
history is never adopted or overwritten. Pairing and agent-store custody remain
held across confirmation; resource cleanup belongs to the cold listener's
lifecycle, not a detached request.

Source APIs in `src/gateway/maintenance-enrollment.ts`:
`prepareGatewayMaintenanceHomeDevice(input, assertCurrent)`,
`enrollGatewayMaintenanceHomeSession(input, options)`, and
`withVerifiedGatewayMaintenanceHomeSession(input, options, consume)`.
Internal input is `{generation,binding,token,ownerInstanceId,request}`; `request`
is the four enrollment fields without generation/stage. Options carry the
already admitted config, current-authority guard and listener-owned resource
scope. These internal functions do not authenticate a network caller themselves;
the cold transport owns signed admission and invokes them under the held fence.

### Recovery and activation release

Lost acknowledgment never authorizes a fresh key, request ID, physical ID or
target. Restart the exact trusted cold process, authenticate root, inspect state,
and explicitly recover ownership. Recovery preserves pending/enrolled plans and
receipts. Retry the same device/session stage; physical-only committed state is
reconciled before shared confirmation. Changed/revoked Home or root credential,
changed target, mismatching physical incarnation, or transcript content refuses.
Mutation uncertainty closes the current connection/runtime; it does not release.

Cold `gateway.maintenance.release` still accepts exactly `{generation}` but is
now **activation-only**: held without an enrolled Home receipt is refused.
Pending is refused. For enrolled state, it rechecks the current Home credential
and exact empty physical session under retained reader/pairing custody, then
performs the shared release CAS. A changed lifecycle revision or transcript
message leaves state enrolled and ordinary startup blocked. There is no abort
endpoint in this slice; abandoned setup requires a human-reviewed recovery
procedure. This intentionally tightens the older cold checkpoint's held release.
Success returns the existing status payload with `state.phase:"released"` and
both enrollment and physical receipt retained; the same process still never
starts normal ingress. Root must verify these exact receipts before any approval
publication and arrange a separate fresh normal process only after all host and
SQL gates qualify.

**Activation blocker: released-state lost acknowledgment.** If release commits
but its acknowledgment is lost and the cold process dies or latches uncertain,
`maintenance-run` refuses the released marker. This checkpoint has no authenticated
offline read-only released-receipt operation. Root must retain its host fence and
withhold approval publication and normal restart until a reviewed reconciliation
procedure establishes the exact released receipt. Service exit, a timeout or a
bootstrap retry is not evidence of successful release.

The v3 exchange authenticates root to the listener, **not the loopback server to
root**. Before accepting any receipt, root must independently pin the listener
to its supervised unit/process UID, exact executable/package digest, port and
process start identity, under its held foreign-writer/config fence. A signature,
loopback URL or maintenance hello alone cannot supply that host attestation.

### Focused evidence and limits

Integrated source review since `090c5907` reported scoped-clean P0–P2 with Sol
medium. Its explicit limits remain the excluded canonical token-comparison helper,
external host fencing and VM/package behavior. Runtime tests are separate evidence.
Shared Home pairing/state/recovery passed 7 tests (21.90 seconds), including
rollback after device and intent writes, discarded-ack reopen/retry, exact
request/key/target rejection, preserved pending ownership recovery, and Home
credential rotation refusal. Public WS two-stage enrollment passed (21.93 seconds);
cold held/pending/enrolled process restart and exact receipt retries passed
(44.83 seconds). Post-enrollment transcript mutation denied release (16.17 seconds).
The session-mutation fixture initially omitted the explicit store path and hit
the intentionally absent normal runtime config; after binding its exact store,
revision mutation denied release and ordinary startup remained blocked (16.25
seconds). The cross-DB interruption fixture commits through the canonical creator
under real offline ownership with the listener stopped, preserves shared pending
state, then reopens the actual cold listener and reconciles the same physical
receipt. This is a deterministic durable interruption cut, not a timed process
kill or an installed host-pipe crash test. The final strengthened case passed in
52.64 seconds and explicitly observed the committed physical row while shared
state was still pending before restarting the cold listener.

Integrated core typecheck and touched-file lint passed. The canonical full build
on Node 26.1.0 passed in 15 minutes 6.4 seconds, including workspace declarations,
unified declarations, SDK exports, core and 98 plugin bundles, UI and startup
import checks. This is source/build evidence; no final immutable runtime package
or installed Linux service has been qualified by this checkpoint.

No broad suite, browser, provider inference, VM, database service, Home/broker,
Telegram, public ingress, or package deployment was exercised. Root host fences,
real principal/config provenance, live SQL control-off and receipt binding,
private-pipe/UID isolation, process/listener attestation, final package provenance
and the existing 4 GB VM capacity remain required activation gates.

## Offline released-receipt reconciliation

This source slice addresses the released/lost-ack blocker above without reopening
the cold listener or changing normal startup. The explicit command is:

```text
openclaw gateway maintenance-released-receipt --request-stdin
```

Both stdin and stdout must be private FIFO/socket pipes. Input is one JSON value,
at most 8 KiB, completed within ten seconds. No credential belongs in argv or
logs. Errors are generic and no success receipt is emitted on refusal. The source
API is `readGatewayMaintenanceReleasedReceiptOffline(value)` in
`src/gateway/maintenance-released-receipt.ts`; it is a one-shot and its process
must exit afterward. The registered CLI skips ordinary config guards/plugin
loading and owns machine-readable stdout.

The closed nine-field request is:

```text
{generation, requestId, enrollmentRequestId, agentId, sessionKey,
 publicKey, token, signedAt, signature}
```

`requestId` is the original bootstrap intent ID; `enrollmentRequestId` is the
recorded Home enrollment ID. Generation and exact target must match the released
state. `publicKey` and `token` belong to the separate root coordinator, never
Home/broker. Public key and signature use raw Ed25519 base64url (43/86 characters).
`signedAt` is integer Unix milliseconds within 120 seconds of verification. Sign
the UTF-8 bytes of `JSON.stringify` of this exact array with the root private key:

```text
["openclaw-maintenance-released-receipt-v1", generation, requestId,
 enrollmentRequestId, agentId, sessionKey, publicKey, token, signedAt]
```

`buildGatewayMaintenanceReleasedPayload` and
`verifyGatewayMaintenanceReleasedRequest` own that source wire contract.
Read-only retries can sign the same journaled identities with a fresh timestamp;
there is no new generation, approval, credential or receipt allocation.

Success is one JSON object, without a WebSocket response envelope:

```text
{version:1, state, receipt:{sessionId,lifecycleRevision},
 readOnly:true, readyForActivation:false}
```

State is the unchanged version-2 released marker, including its original process
owner ID, coordinator binding and Home enrollment. No token is returned. The
current root approval/token identity and current Home credential must still
match. The command verifies the exact physical session and lifecycle, empty
transcript header/watermark and absence of an active writer. It refuses any other
phase, missing receipt, changed target or credential, changed physical session,
retained transcript content, concurrent Gateway owner or unknown plugin policy.

Only canonical per-agent session stores are supported; custom/shared/ambiguous
store layouts fail closed. The command uses `sqlite-maintenance` lock custody,
artifact-preserving shared reads and a private agent database snapshot. The
canonical native session-read kernel runs under the existing CLI one-shot
exception; its physical-receipt validator is shared with live enrollment/release.
Normal Gateway lease reads and ordinary session workers can create empty source
WAL/SHM files, so they are not used for this offline inspection. No source sidecar
cleanup is used to hide writes. Snapshot resources close before lock release;
failed cleanup preserves ownership.

Root must retain the foreign-writer/config fence before launch and through
receipt acceptance/publication, pin the exact executable/package and UID, and
compare every receipt field with its private journal. The output is a verified
snapshot under that custody, not a durable permission to activate later. The
command does not prove the external host/SQL fence, publish approvals, release a
generation, start a service, or authenticate a loopback listener.

Focused native tests passed 4/4 (110.50 seconds): discarded release acknowledgment
and fresh-process retry (51.37 seconds), changed physical revision (20.11),
transcript mutation (19.82), and Home credential rotation (18.72). They exercise
the registered CLI over private pipes, wrong signed coordinator/generation/token/
enrollment ID, concurrent-owner refusal, unchanged SQLite/WAL/SHM bytes and no
plugin JS. For contention, the comparison begins after the competing normal
Gateway owner opens its own lease sidecars. The existing public enrollment/release
boundary passed again (21.70 seconds), as did all three targeted CLI startup-policy
cases. Core typecheck and touched-file lint passed. An inherited indexed-access
type error in the prior checkpoint's final strengthened test assertion was fixed
with an explicit row-presence assertion; its runtime behavior was already tested.

The root package declares Node `>=24.16.0 <25 || >=26.1.0`. This slice's tests use
Node 26.1.0; TEST's Node 24.22.1 is in range but still needs focused runtime proof.
No VM, Nate checkout, external database, GitHub or runtime installation changed.

Fresh independent autoreview reported scoped-clean P0–P2 (Sol medium), retaining
the external-fence/attestation/journal and excluded token-comparison coverage
limits. The canonical Node 26.1.0 build passed in 14 minutes 51.6 seconds, including
workspace and unified declarations, core/plugin bundles, SDK export checks,
startup-import checks and UI. These are source gates; no immutable root runtime
package or installed Linux unit is qualified by this checkpoint.
