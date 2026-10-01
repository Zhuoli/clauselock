# ClauseLock security review

Scope: `programs/clauselock/src/lib.rs`, `programs/clauselock/tests/escrow.rs`, `sdk/index.ts`, `fineprint/adapter.ts`.
Offline source review; no network, installs, or source edits. Node reproductions confirmed the adapter issues below; both supplied terms vectors passed independent byte/hash checks.
LiteSVM and the full SDK suite were **not run**: this checkout lacks `target/deploy/clauselock.so` and `node_modules`. Findings are not a deployed-binary audit.

## 1. Fund loss / lock-up and terms-integrity findings

No critical/high unauthorized reward-drain path found. Signers, PDA seeds, fixed destinations, state transitions, and `<`/`>=` deadline boundaries are consistent. Approved rewards remain payable indefinitely.
Sponsor non-approval followed by refund is the disclosed policy, not an authorization vulnerability.

**Medium — adapter accepts unsupported payment promises.** `fineprint/adapter.ts:79-99,105-118`.
- `discretion` must exist, but its value is never checked; `sponsorDiscretion: false` with an automatic-payment quote still returns `ok: true`, alongside the opposite hardcoded disclosure.
- Likewise, contributor clause values are not bound to `input.contributor`; only the field's presence is required. A named-wallet clause can disagree with the resulting party.
- Impact: a contributor can accept a cryptographically consistent document containing contradictory promises, do the work, then receive nothing under the actual sponsor-discretion policy (`programs/clauselock/src/lib.rs:299-305,357-369`). This is semantic integrity failure, not a bypass of the signed hash.
- Fix: require `sponsorDiscretion === true`; define the supported contributor schema (`role: invited` or an exact matching wallet), reject alternatives, and retain validated normalized values in the document. Human quote accuracy still needs explicit review.

**Medium — ambiguous deadlines and unchecked display instants.** `fineprint/adapter.ts:36,93,124-135`.
- `Date.parse` accepts timezone-free datetimes. The same packet compiled to accept-by `1791269999` under UTC and `1791295199` under America/Los_Angeles: seven hours apart.
- `checkDocAgainstChain` also returns no errors for a document with `accept_by_iso` set to 2099 while its numeric deadline remains 2026, if that inconsistent document's digest was committed originally.
- Impact: users relying on display labels can miss action deadlines and lose eligibility for the reward; matching the digest establishes integrity, not internal consistency.
- Fix: require explicit `Z`/offset and second precision, reject invalid/calendar-normalized dates, and verify every ISO label against its numeric value (or derive labels instead of storing them).

**Low — unsolicited excess SOL is permanently stranded.** `programs/clauselock/src/lib.rs:172-177,338-348,365-374`.
- Settlement transfers exactly `amount`; any extra transfer to the PDA survives forever, including deposits after Paid/Refunded. No recovery instruction exists.
- The retained rent reserve is an intentional receipt-storage cost, not lost reward; excess deposits are a separate lock-up.
- Fix: add a terminal-state-only sweep of balance above rent to the fixed sponsor, preserving the receipt/PDA and preventing escrow-ID reuse. Document that donations return to the sponsor.

## 2. Missing tests and verification gaps

- `programs/clauselock/tests/escrow.rs:48`: tests embed an existing `.so`; `cargo test` alone does not establish that it matches the reviewed source. Build SBF first in CI and record source/artifact hashes.
- `escrow.rs:395-410`: forged-owner test exists, but add a program-owned, correctly serialized account at a wrong PDA, corrupted bump/seeds, wrong discriminator, and missing signer/read-only metas.
- `escrow.rs:198-245`: exercise exactly `MIN_AMOUNT` with an empty payout wallet after acceptance and an independent fee payer; also an emptied sponsor receiving refund, sponsor self-refund, and CPI/PDA participants if supported.
- Add excess-deposit settlement, prefunded uninitialized escrow PDA creation, and insufficient-above-rent payout rollback; assert reward, receipt, and destination balances on failures.
- `escrow.rs:415-438,457-560`: add the full state/action matrix, including payment after refund, cancel after submission, repeated submit/approve, and separate fixtures at deadline−1/deadline/deadline+1. Current tests sometimes move time backward and omit +1 cases.
- `sdk/test.ts:11-78`: no instruction-byte/account-meta or account-decoder parity tests. Execute SDK-built instructions in LiteSVM and decode a Rust-serialized fixture; test all seven builders and integer limits.
- Add adapter regressions for the reproduced findings, invalid/overflow/unsafe-number amounts and escrow IDs, malformed dates, unknown schemas, duplicate/missing clause IDs, dangling conflict claims, and contradictory overlapping resolutions. Invalid input should return structured issues, not throw or produce `ok: true`.

## 3. SDK byte layouts / discriminators

No mismatch found for valid v1 inputs: program ID, PDA seeds (`escrow`, sponsor, u64 LE ID), field order, signed i64 deadlines, account metas, enum ordinals, and error ordering agree.
- Terms preimage: **157 bytes**. `create_fund`: **113 bytes** including discriminator; accept/submit: **40**; other instructions: **8**.
- Escrow: **284 bytes** including discriminator; state byte offset **211**, `settled_by` offset **252** (`lib.rs:54-78`; `sdk/index.ts:91-104`).
- Expected discriminator hex: create `2680120bcb009915`; accept `419646d885066b04`; submit `0ca9e4c2e51f2c27`; approve `454ad9247375614c`; cancel `e8dbdf29dbecdcbe`; payment `fefe2e28167edd80`; refund `a2fa7826b67d5b6c`; Escrow `1fd57bbbba16da9b`.
- **Low, input coercion:** `sdk/index.ts:22,39-41,58` silently wraps/truncates u8 values: policy `256` encodes as accepted policy `0`. Validate integer range and supported schema/policy before hashing/building.
- **Low, decoder validation:** `sdk/index.ts:91-104` checks only the discriminator, not exact v1 size, schema, or state range; malformed inputs can yield undefined state or throw later. Validate these and provide an AccountInfo-aware wrapper checking owner/PDA before displaying or signing. This does not bypass on-chain checks.

## 4. Five judge-facing improvements (choose a 2–3 day scope)

1. **Verified acceptance screen:** show reward, fixed recipient, cluster-time deadlines, document/hash checks, and conspicuous sponsor-discretion disclosure; block signing on any mismatch.
2. **One-transaction approval + payment:** compose existing instructions atomically; retain permissionless finalizers as recovery buttons, with simulation, confirmation, and devnet Explorer links.
3. **Shareable bounty/receipt page:** wallet actions by role, funded balance, current state, deadline countdowns, and transaction history; make the devnet badge and fee/rent costs visible.
4. **Retrievable evidence and terms:** downloadable canonical document plus content-addressed deliverable manifest; verify retrieved bytes against the committed hashes before review.
5. **Integration kit:** publish IDL, typed SDK, full serialization fixtures, and a minimal CPI/relayer example showing fixed destinations and independently sponsored transaction fees.
