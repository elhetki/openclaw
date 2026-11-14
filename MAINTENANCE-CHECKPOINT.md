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

OpenRouter and Nate native manifests do not receive consent merely because this
contract exists. Each requires its own explicit reviewed declaration. Nate must
also retain a separate root-held coordinator credential; the Home/broker admin
credential is not maintenance authority. No TEST activation is qualified.

## Required next patch sequence

1. Select maintenance control bootstrap at `src/gateway/server.ts` after state
   ownership but before `startGatewayServerWithRuntime` starts ordinary resources.
   Preserve `server-startup-bootstrap.ts`'s existing refusal as defense for other
   entrypoints. An active generation must restore admission before producer
   setup. Never use minimal-test or update-canary flags as production authority.
   Read complete metadata for every configured workspace, admit manifest consent,
   and retain config observation without loading plugin JavaScript. Current
   refusal must remain until real restart tests prove the replacement path.
2. Extend the runtime owner into recovery. Existing protocol handlers bind the
   generation to the authenticated, current coordinator device token and exact
   agent/session; reject shared-token, other-device, stale-owner and revoked
   credentials. Revalidate at effect commit after awaits. Syntax validation of
   the stored binding is not authentication.
3. The runtime handlers now close admission before persisting begin, pause cron
   scheduling, and inspect the
   complete `createGatewayActiveWorkSnapshot` plus server inspectors and write
   custody. Qualify this through public WebSocket and lifecycle tests, including
   exact pending-operation continuations while draining. Never
   call a snapshot with omitted inspectors an all-writer proof. Keep closure on
   persistence/inspection failure; no timer may reopen it.
4. Introduce one capability-scoped enrollment operation, not an exemption for
   general `sessions.create`. At `session-create-service.ts`'s
   `createSessionEntryWithTranscript` callback, require actual row absence and the
   exact canonical target. Existing sessions are otherwise adoptable today.
   Persist pending before mutation, record the real lifecycle receipt, and keep
   uncertain outcomes closed. Prove public transport and post-publication reads.
   The low-level creator accepts caller-prepared session IDs/revisions and carries
   observed absence into its native worker conflict check. A planned receipt may
   therefore allow crash reconciliation without adding another session store,
   but this must be proven at the canonical transaction and publication boundary.
5. Implement explicit crash reconciliation for pending/enrolled states and a
   generation-bound release CAS. Current state transition deliberately refuses
   automatic recovery of these states. Never reopen based on a lost response,
   expiry, matching session key alone, or startup reset.
6. Prove cold restart, same-process restart, revoked device during await, concurrent
   begin/enroll/release, lost reply, crashes around each durable boundary,
   ordinary HTTP/WS/plugin/cron rejection, drain custody, and default-off behavior.

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
