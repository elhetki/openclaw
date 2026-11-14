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
- An internal admission capability rejects ordinary/independent roots and restart
  exceptions while existing admitted work can finish. Runtime reset does not clear
  it. No production controller currently acquires this capability.
- Ordinary bootstrap refuses an active/malformed maintenance marker before session
  migrations, plugin bootstrap and channel/scheduler startup. This is a refusal,
  not a restored control-only server. Existing startup maintenance handling parks
  managed launchd and uses exit 78 for systemd policy; guidance preserves the marker.

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

## Required next patch sequence

1. Split maintenance control bootstrap from normal startup in
   `src/gateway/server-kernel.ts`, `server-startup-bootstrap.ts`,
   `server-core-runtime.ts`, and `server-startup-finish.ts`. An active generation
   must restore admission before producer setup. Never use minimal-test or
   update-canary flags as production authority. Current refusal must remain until
   real restart tests prove the replacement path.
2. Add a single runtime owner and protocol descriptors/schemas/handlers. Bind the
   generation to the authenticated, current coordinator device token and exact
   agent/session; reject shared-token, other-device, stale-owner and revoked
   credentials. Revalidate at effect commit after awaits. Syntax validation of
   the stored binding is not authentication.
3. Close admission before persisting begin, pause cron scheduling, and join the
   complete `createGatewayActiveWorkSnapshot` plus server inspectors and write
   custody. Preserve exact pending-operation continuations while draining. Never
   call a snapshot with omitted inspectors an all-writer proof. Keep closure on
   persistence/inspection failure; no timer may reopen it.
4. Introduce one capability-scoped enrollment operation, not an exemption for
   general `sessions.create`. At `session-create-service.ts`'s
   `createSessionEntryWithTranscript` callback, require actual row absence and the
   exact canonical target. Existing sessions are otherwise adoptable today.
   Persist pending before mutation, record the real lifecycle receipt, and keep
   uncertain outcomes closed. Prove public transport and post-publication reads.
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
