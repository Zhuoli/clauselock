# ClauseLock UI review — 2026-10-03

Static review of `web/src/*.tsx`, `web/src/lib.ts`, `web/src/styles.css`, `web/index.html`, and `web/vite.config.ts`, cross-checked against the SDK, terms adapter, and Anchor program. No network commands or runtime tests were run.

1. **High — Editing an address silently changes the signing target.** `web/src/EscrowView.tsx:48`, `web/src/EscrowView.tsx:88`, `web/src/ContributorView.tsx:38`.
   After loading escrow A, paste valid escrow B without pressing Load: the displayed state/terms still describe A, but instruction builders use B. Approve/cancel can succeed for B when the same sponsor owns both; submit can target another accepted escrow for the same contributor. Invalid intermediate input also throws during render. Accept's expected hash protects against accepting different terms, but the other actions lack that protection.
   **Fix:** Store the successfully loaded address with its account snapshot; build every instruction/share link from that address. Invalidate actions when draft input differs, and parse addresses only inside guarded loading code.

2. **High — Cluster changes retain verified state from the previous network.** `web/src/ContributorView.tsx:30`, `web/src/EscrowView.tsx:37`, `web/src/App.tsx:72`.
   Contributor loading runs only on mount, so changing clusters preserves the old document, verification badge, acknowledgment, and state while transactions use the new connection. Status reloads on connection changes but retains actionable old data until completion, including after RPC/decode errors; old requests can also overwrite newer results. A matching PDA on both networks can represent different lifecycle state.
   **Fix:** Bind snapshots and pending actions to cluster/program/address; clear them immediately on network change, ignore obsolete responses, reload before enabling signing, and prevent network/identity changes during a pending wallet request. Synchronize the URL cluster too: currently reload can restore the old fragment's cluster over the new stored selection.

3. **Medium — The funding button can quote a different amount from the transaction.** `web/src/SponsorView.tsx:19`, `web/src/SponsorView.tsx:29`, `web/src/SponsorView.tsx:105`.
   In packet-date mode, the actual amount comes from the packet but the button still uses the demo `reward` state. Starting on devnet and selecting packet dates can label funding as 0.05 SOL while the bundled packet transfers 1 SOL. The terms card disagrees with the final action label.
   **Fix:** Derive the button amount and pre-sign summary from `compiled.doc.amount_lamports`, exactly as the instruction does; distinguish reward, rent, and transaction fee.

4. **Medium — Status presents unverified document quotations next to irreversible wallet actions.** `web/src/EscrowView.tsx:42`, `web/src/EscrowView.tsx:72`, `web/src/EscrowView.tsx:88`.
   Any parsed fragment document wins over cached terms, without checking its digest or fields against the account. An altered share link can therefore show fabricated deadline clauses and explanations beside Approve, and propagate that document through sharing/download. Contributor acceptance does perform the checks, so this is a status/review trust gap rather than an accept-hash bypass.
   **Fix:** Apply the contributor's document/hash checks before using citations or redistributing terms; visibly separate unverified material and require verified terms for sponsor review/approval.

5. **Medium — RPC failure can leave funding permanently busy with no visible error.** `web/src/lib.ts:35`, `web/src/SponsorView.tsx:42`, `web/src/App.tsx:60`.
   `getLatestBlockhash` executes outside `run`'s try/catch. If it rejects, callers receive an unhandled rejection; funding never reaches `setBusy(false)`. Airdrop likewise has no catch and ignores confirmation's `value.err`. Wallet rejection, transport failure, and program rejection are otherwise all labeled “Program rejected.”
   **Fix:** Catch the complete transaction path, release busy state in `finally`, handle/check airdrop results, and distinguish wallet/RPC/program errors in visible feedback.

6. **Medium — Confirmation can use the wrong blockhash lifetime and loses submitted signatures on failure.** `web/src/lib.ts:22`, `web/src/lib.ts:35`, `web/src/lib.ts:46`.
   `run` captures a blockhash/expiry pair, but the burner fetches and signs with another blockhash. Confirmation still uses the first pair and can report premature expiry. Any confirmation exception discards the signature and appears as a definitive rejection even though the transaction may have landed.
   **Fix:** Preserve one blockhash/expiry pair through signing and confirmation (or return the actual pair from the sender). Retain the signature after broadcast, report uncertain confirmation as pending/unknown, and reconcile signature/account status before inviting a retry.

7. **Medium — Repeated clicks can open multiple wallet requests.** `web/src/ContributorView.tsx:40`, `web/src/EscrowView.tsx:50`, `web/src/App.tsx:88`.
   Accept, submit, approve, settlement, sweep, and airdrop have no in-flight guard. Concurrent attempts race, produce confusing success/error ordering, and may incur failed-transaction fees; program state checks generally prevent duplicate settlement, not duplicate signing requests.
   **Fix:** Add an immediate per-action in-flight guard and visible pending state; disable related controls until confirmation/reconciliation finishes.

8. **Medium — Unvalidated JSON and URL parameters can blank the app.** `web/src/App.tsx:16`, `web/src/SponsorView.tsx:38`, `web/src/ContributorView.tsx:32`, `web/src/ContributorView.tsx:64`, `web/src/lib.ts:73`.
   `#cluster=garbage` is cast into the endpoint lookup without validation. Uploaded/fragment JSON is treated as typed data: `{}` passes parsing but crashes packet compilation or terms rendering/verification; malformed uploaded JSON rejects without inline handling. Non-finite demo-minute values can also throw from date conversion during render.
   **Fix:** Allowlist cluster/view values; schema-validate packets/documents and finite, bounded numeric inputs before setting state; catch parse/validation failures and show actionable inline errors.

9. **Medium — Deadline guidance becomes stale during the short demo.** `web/src/ContributorView.tsx:26`, `web/src/ContributorView.tsx:30`, `web/src/SponsorView.tsx:25`, `web/src/lib.ts:53`, `web/src/EscrowView.tsx:77`.
   Contributor time/state never refresh while idle, so an expired or externally refunded offer can continue to appear open. Demo deadlines are anchored when the form loads/offsets change, so spending two minutes resolving terms can expire the default acceptance deadline before funding. RPC failure silently substitutes the computer clock while status calls it “Cluster time.”
   **Fix:** Refresh chain state/time periodically and on focus, label fallback time, and gate actions on current eligibility. Offer an explicit deadline refresh that redisplays the changed terms for review before funding; do not silently shift signed terms.

10. **Medium — Successful contributor transactions erase their own receipts; balances remain stale.** `web/src/ContributorView.tsx:21`, `web/src/ContributorView.tsx:42`, `web/src/App.tsx:52`.
    `act` sets a successful result and immediately calls `load`, which clears it, removing the confirmation/Explorer link. Header balance refreshes only on actor/connection changes or airdrop, so funding, payment, and refund leave misleading balances.
    **Fix:** Separate account refresh from clearing transaction feedback; retain the confirmed signature and refresh the active wallet balance after confirmation.

11. **Medium — Sponsor cannot inspect or verify the submitted evidence in the UI.** `web/src/ContributorView.tsx:79`, `web/src/EscrowView.tsx:20`, `web/src/EscrowView.tsx:88`.
    Evidence text is saved only in the contributor browser's localStorage, never displayed/read by the sponsor view. Status shows only a truncated hash beside an irreversible Approve button. Separate-wallet/browser demos have no evidence handoff or hash verification path.
    **Fix:** Provide copy/export of evidence and sponsor-side paste/upload with SHA-256 comparison against the complete on-chain hash; display the verified content and approval's irreversible consequence before signing.

12. **Low — Key controls and asynchronous feedback lack accessible identification.** `web/src/ContributorView.tsx:49`, `web/src/EscrowView.tsx:58`, `web/src/EscrowView.tsx:95`, `web/src/EscrowView.tsx:98`, `web/src/TermsCard.tsx:10`.
    Escrow inputs rely on disappearing placeholders, the share input has no associated label, and transaction/error changes have no live-region semantics. Citation quotes rely on mouse-hover titles on non-focusable spans, making the core terms-to-chain demonstration harder with keyboard or assistive technology.
    **Fix:** Add persistent associated labels, `role="status"`/`role="alert"` feedback, and focusable citation buttons or links that reveal the source quote on keyboard activation.

Checked safeguards: SDK/program IDs agree in the repository; fetched accounts are checked for owner/PDA/schema; contributor acceptance compares document digest and executable fields, recomputes the terms hash, requires acknowledgment, and sends the expected hash. No unsupported mainnet-routing or cryptographic accept-bypass claim is made; live wallet behavior/deployment was not checked.
