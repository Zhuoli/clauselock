# Colosseum Crypto World's Fair: ClauseLock submission draft

Draft written 2026-10-03 PT. **Not submitted.** Deadline: Mon Oct 12, 2026, 11:59 PM PT (registration and submission). Target: Sat Oct 10.
Fields follow the portal's published list (colosseum.com/hackathon FAQ): name, description, chains and tools, team, location, logo, GitHub, pitch video (2–3 min), product-demo video (≤3 min), go-to-market and demand validation. All content is in English.

Items marked **[Zhuoli]** need his input or account before submitting.

---

## Project name
ClauseLock

## One-liner
Bounty escrow on Solana where the terms you read are the terms that execute.

## Short description (≈50 words)
ClauseLock turns a bounty's fine print into a funded, verifiable agreement. Fine Print, a rules-reading agent, extracts every amount and deadline from the bounty's documents with verbatim citations and blocks on conflicts. A Solana program escrows the reward, computes a hash of the terms on-chain, and settles on deadlines. Anyone can trigger settlement; nobody can redirect it.

## Full description
Bounties, hackathon prizes and grants are usually a promise, not money set aside. The terms are spread across a listing page, an FAQ and the official rules. They often disagree (the demo uses a real pattern: the listing says "October 14", the Terms say "October 12, 11:59 PM PT"), and they can change after work starts.

ClauseLock fixes the parts a chain can actually fix:

1. **Read.** Fine Print parses the bounty's rule packet into sources (with precedence), clauses (verbatim quote and normalized value) and conflicts. If a required field is missing or two sources disagree, it returns **BLOCKED** with both quotes, and the sponsor must resolve the conflict before anything can be funded.
2. **Compile.** The resolved packet becomes a canonical terms document (stable JSON). Every executable field (reward, contributor, `accept_by`, `submit_by`, `review_by`, refund policy, discretion) cites the clause it came from. `doc_digest = sha256(canonical_json)`.
3. **Lock.** `create_fund` moves the reward into a program-owned PDA and computes `terms_hash` **on-chain** from the executable fields plus `doc_digest`. The invited contributor accepts by signing that exact hash; a mismatch fails with `TermsMismatch`. No instruction can edit the terms.
4. **Settle.** The contributor submits an evidence hash, and the sponsor approves. Approval is irrevocable. After approval anyone can call `finalize_payment`, which pays the pinned contributor. If a deadline passes, anyone can call `finalize_refund`, which returns the reward to the pinned sponsor.
5. **Explain.** Deterministic `can_*` explainers answer "why can't I refund yet?" from on-chain state, with the governing clause ID and quote.

**Honest boundary.** The sponsor still judges the work. If they don't approve by `review_by`, the reward goes back to them. ClauseLock prevents hidden term changes and unfunded promises; it does not guarantee payment for submitted work. Every terms document states this, and the contributor must acknowledge it before the Accept button unlocks.

## Problem
- Rewards are often unfunded promises, and contributors can't tell before doing the work.
- Terms live in several documents that conflict. Which one governs is decided after the fact, usually by the sponsor.
- Terms can be changed after a contributor starts.
- When something doesn't pay out, nobody can explain why with reference to the actual rules.

## Solution
A rules reader that refuses to guess, plus a Solana escrow that locks exactly what was read:
- Conflicts are resolved and recorded *before* funding, never in a dispute afterwards.
- The reward is in a program account from the first minute.
- The contributor signs a hash the program recomputes from the stored fields, so what the UI showed is what executes.
- Each state has a written settlement rule tied to a deadline, and settlement is permissionless to fixed destinations: no admin key, no keeper, no oracle.

## Who it is for
Bounty and hackathon sponsors (Superteam Earn-style boards, DAO grant programs, open-source bounties, bug bounties) and the contributors who want proof that the reward exists and the rules won't move.

## How it uses Solana / Why Solana
- **Program-owned custody.** A PDA per escrow (`["escrow", sponsor, escrow_id]`) holds reward + rent; payouts debit it directly; accounts are kept as receipts and as replay protection.
- **On-chain terms commitment.** `terms_hash = sha256("CLAUSELOCK_TERMS_V1" | schema | sponsor | contributor | escrow_id | amount | accept_by | submit_by | review_by | refund_policy | doc_digest)`, computed by the program itself so no client can submit a hash that disagrees with the stored fields. Cross-language test vectors (Rust, TS, independent Python).
- **Clock-driven state machine.** `Clock::unix_timestamp`: positive actions need `now < deadline`, expiry needs `now >= deadline`; tested one second before, at, and after every deadline.
- **Permissionless settlement.** Any wallet can pay or refund; destinations are pinned with `has_one`.
- **Why Solana specifically.** A bounty flow is 5–6 transactions. At sub-cent fees and sub-second to few-second confirmation that is invisible to users, and the escrow state is public for anyone to verify. Wallet Standard (Phantom) works in the browser with no custom wallet code.

## Technical stack / chains and tools integrated
- Solana (devnet), Anchor 1.2 (Rust), native SOL. SBPF v1 build (`anchor build --arch v1`), reproducible sha256 `c0d51912…cdcd2`.
- LiteSVM: 23 program tests (wrong signer/PDA/destination, replay, double payout, exact-second deadlines, Approved never refunds, hash mismatch).
- TypeScript SDK (`sdk/`): PDA, terms hash, instruction builders, verified account decoder, `explain()`; 9 tests.
- Fine Print adapter (`fineprint/`): rule packet → conflict gate → canonical terms document + digest; doc-vs-chain check.
- Web UI: Vite + React 19, `@solana/wallet-adapter` with Wallet Standard (Phantom), localnet burner wallets; Playwright end-to-end tests (happy path, refund path).
- CLI (`scripts/terms.ts`), end-to-end demo script (`scripts/demo.ts`) run on devnet.
- Reviews: two offline Codex reviews (program/SDK on Oct 1, web UI on Oct 3), with fixes in the repo.

## Deployment / proof
- Devnet program: `B5qem1S6padkAWwpAYzHeNDjnPHN6NHdmWRuacgvdgDu`: https://explorer.solana.com/address/B5qem1S6padkAWwpAYzHeNDjnPHN6NHdmWRuacgvdgDu?cluster=devnet
- Full demo on devnet (one escrow paid by a third wallet, one refunded after `accept_by`; `TermsMismatch`, `ApprovedCannotRefund`, `WrongState`, `RefundNotYetAvailable` rejected): transaction links in the README ("Devnet status") and `docs/devnet/demo-receipts-2026-10-03.json`.
- Upgrade authority: retained by the deployer during development, disclosed in the README. Plan: freeze (`--final`) the reviewed deployment before judging. **[Zhuoli: decide]**

## Links
- GitHub (public, Apache-2.0): https://github.com/Zhuoli/clauselock
- Fine Print (reused rules model): https://github.com/Zhuoli/fine-print
- Pitch video: `docs/pitch.mp4` in the repo (2:36, voiceover + captions). **[Zhuoli: upload as unlisted YouTube/Loom; paste URL]**
- Product-demo video (≤3 min, technical): `docs/demo.mp4` if produced; otherwise reuse the pitch video's UI segment. **[paste URL]**
- Devnet Explorer: see above.

## Team
- **Zhuoli Liang**: solo builder. Independent software engineer (self-employed). Built Fine Print, a rules-reading agent for contest and bounty terms, then ClauseLock on top of it for this hackathon. **[Zhuoli: add 1–2 lines of background/prior experience and links (GitHub, X)]**
- Location: **[Zhuoli: city, country]**
- Build disclosure: development used AI coding assistants (Codex for reviews and code), directed and reviewed by Zhuoli.

## What was built during the hackathon vs reused
- Reused (pre-existing, Zhuoli's own): Fine Print's content model (rule sources with precedence, clauses with verbatim quotes, conflicts) and its "deterministic verdict + clause IDs" style.
- New for this hackathon: the Solana program and its tests, terms schema and on-chain commitment, test vectors, TS SDK, conflict gate and canonical terms document, `can_*` explainers, CLI, web UI, e2e tests, devnet deployment and demo.

## Business model / go-to-market
- **Open core.** The program, SDK and terms schema stay open and free to call directly (composability matters: any bounty board can integrate the escrow).
- **Revenue.** (1) A paid sponsor workspace: Fine Print rule reading, conflict review, bulk escrows, audit/export of receipts. (2) Later, a small settlement fee (basis points) on funded bounties that use the hosted flow.
- **First users.** Hackathon and bounty sponsors on Solana (Superteam Earn-style listings, ecosystem grant programs), then open-source and bug bounties. Integration path: an embeddable "Fund with ClauseLock" button plus the SDK.
- **Distribution.** Partner with one bounty board for a pilot; publish the terms schema as a standard; make the "terms verified" badge visible to contributors so they ask sponsors for it.
- **Sponsor/partner ideas.** Superteam (Earn), Solana Foundation grants, Phantom (wallet UX for signing a terms hash), hackathon organizers who want verifiable prize custody, and stablecoin issuers once USDC rewards ship.

## Demand validation
No user interviews or pilots yet; we are not claiming any. Next step: 5–10 sponsor interviews and one pilot commitment before claiming market size. The problem is real but anecdotal so far: running Fine Print on a real challenge found its FAQ and Official Rules disagreeing on when the paperwork clock starts. **[Zhuoli: add any real conversations, if any]**

## Roadmap
SPL/USDC rewards → multi-milestone and multi-contributor escrows → optional arbiter for disputes → frozen, audited deployment → bounty-board integration pilot.

## Logo
`docs/logo.png` (512×512) and `docs/logo.svg`.

## Pre-submit checklist
- [ ] Zhuoli registered on colosseum.com (done: robotonyszu) and joined the World's Fair.
- [ ] Videos uploaded (unlisted is fine) and links open in a private window.
- [ ] GitHub repo public (done) and README current.
- [ ] Decide upgrade authority (freeze or disclose; currently disclosed).
- [ ] Optional: real Phantom click-through of the web UI on devnet.
- [ ] Fill the **[Zhuoli]** items above, then submit by Oct 10.
