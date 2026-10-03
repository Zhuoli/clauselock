// Full-screen 1280x720 slides rendered in the same browser page as the UI recording.
const css = `body{margin:0;width:1280px;height:720px;background:#0f1218;color:#eef1f5;font-family:'DejaVu Sans',system-ui,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box}
h1{font-size:64px;margin:0 0 12px} h2{font-size:42px;margin:0 0 28px;color:#fff} .tag{font-size:28px;color:#b39ddb} .k{color:#f4b400}
ul{font-size:27px;line-height:1.55;padding-left:30px;margin:0} li{margin:4px 0} code{font-family:'DejaVu Sans Mono',monospace;font-size:20px;color:#a5d6a7}
.small{font-size:20px;color:#9aa4b2;margin-top:26px} .flow{display:flex;gap:18px;align-items:center;font-size:24px;margin-top:10px}
.box{border:2px solid #512da8;border-radius:12px;padding:16px 18px;background:#171b24;flex:1} .box b{display:block;font-size:26px;margin-bottom:6px;color:#fff}
.arrow{font-size:36px;color:#b39ddb} table{font-size:19px;border-collapse:collapse;margin-top:4px} td{padding:5px 14px 5px 0} td:first-child{color:#9aa4b2}`
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`

export const slides: Record<string, string> = {
  title: page(`<h1>ClauseLock</h1><div class="tag">The terms you read are the terms that execute.</div>
    <p class="small">Fine Print reads the bounty rules · a Solana escrow locks them · Colosseum World's Fair 2026</p>`),
  problem: page(`<h2>Bounty terms drift, and rewards are only promises</h2><ul>
    <li>The listing says <span class="k">Oct 14</span>. The official terms say <span class="k">Oct 12, 11:59 PM PT</span>.</li>
    <li>The reward is held off-chain, or never funded at all.</li>
    <li>Terms can change after the work starts.</li>
    <li>Which document counts? Nobody knows until a dispute.</li></ul>`),
  solution: page(`<h2>Read the rules, then lock them on Solana</h2><div class="flow">
    <div class="box"><b>Fine Print</b>AI rules reader: every amount and deadline with a verbatim quote and source. Blocks on conflicts.</div><div class="arrow">→</div>
    <div class="box"><b>Terms document</b>Canonical JSON, every field cites a clause. <code>doc_digest</code> = sha256.</div><div class="arrow">→</div>
    <div class="box"><b>Solana escrow</b>Reward, parties, 3 deadlines. <code>terms_hash</code> computed on-chain; accept signs it.</div></div>
    <p class="small">fund → accept(hash) → submit evidence → approve → anyone pays · or anyone refunds after a missed deadline</p>`),
  devnet: page(`<h2>Live on Solana devnet</h2><table>
    <tr><td>Program</td><td><code>B5qem1S6padkAWwpAYzHeNDjnPHN6NHdmWRuacgvdgDu</code></td></tr>
    <tr><td>Escrow A</td><td>create_fund → accept → submit_evidence → approve → <b>finalize_payment</b> by a third wallet</td></tr>
    <tr><td>Escrow B</td><td>nobody accepts → early refund rejected → <b>finalize_refund</b> after accept_by</td></tr>
    <tr><td>Rejected as designed</td><td><code>TermsMismatch</code> · <code>ApprovedCannotRefund</code> · <code>WrongState</code> · <code>RefundNotYetAvailable</code></td></tr>
    <tr><td>Tests</td><td>23 program tests (LiteSVM) · 9 SDK tests · 2 browser end-to-end tests</td></tr></table>
    <p class="small">Explorer links for every transaction: github.com/Zhuoli/clauselock (README → Devnet status)</p>`),
  close: page(`<h2>Why Solana, and what's next</h2><ul>
    <li>Fees are a fraction of a cent; confirmation takes seconds; state is public.</li>
    <li>Open, free program. Revenue: a sponsor workspace, later a small settlement fee.</li>
    <li>First users: hackathons, grant programs, bug bounties.</li>
    <li>Next: SPL/USDC rewards, milestones, a frozen audited deployment.</li></ul>
    <p class="small">Built by Zhuoli Liang (solo) · open source, Apache-2.0 · <span class="k">github.com/Zhuoli/clauselock</span></p>`),

  d_arch: page(`<h2>Architecture</h2><div class="flow">
    <div class="box"><b>Fine Print adapter (TS)</b>rule packet → conflict gate → canonical terms JSON + <code>doc_digest</code></div><div class="arrow">→</div>
    <div class="box"><b>Web app + SDK (TS)</b>React 19, wallet-adapter (Wallet Standard / Phantom), PDA + ix builders, verified decoder, <code>can_*</code></div><div class="arrow">→</div>
    <div class="box"><b>Anchor program (Rust)</b>PDA custody, on-chain <code>terms_hash</code>, clock-driven state machine</div></div>
    <p class="small">Devnet: B5qem1S6padkAWwpAYzHeNDjnPHN6NHdmWRuacgvdgDu · SBPF v1, reproducible build</p>`),
  d_program: page(`<h2>Program: one PDA per escrow, deadlines decide</h2><ul style="font-size:23px">
    <li>PDA <code>["escrow", sponsor, escrow_id_le]</code>: reward on top of rent; kept as receipt + replay guard</li>
    <li><code>create_fund</code> → Funded → <code>accept(hash)</code> → <code>submit_evidence</code> → <code>approve</code> → <code>finalize_payment</code> → Paid</li>
    <li>Expiry: <code>finalize_refund</code> at <code>now ≥ accept_by / submit_by / review_by</code> → Refunded · Approved never refunds</li>
    <li>Positive actions need <code>now &lt; deadline</code> (Clock::unix_timestamp)</li>
    <li>Settlement is permissionless; destinations pinned with <code>has_one</code></li></ul>`),
  d_hash: page(`<h2>The program computes the terms hash</h2>
    <p style="font-size:22px;line-height:1.6"><code style="font-size:22px">terms_hash = sha256("CLAUSELOCK_TERMS_V1" | schema | sponsor | contributor | escrow_id | amount | accept_by | submit_by | review_by | refund_policy | doc_digest)</code></p>
    <ul style="font-size:24px"><li>157-byte little-endian preimage, built on-chain from the stored fields</li>
    <li><code>accept(expected_terms_hash)</code>: mismatch → <code>TermsMismatch</code></li>
    <li>Test vectors shared by Rust, TypeScript and an independent Python implementation</li></ul>`),
  d_tests: page(`<h2>Tests and proof</h2><ul>
    <li>23 LiteSVM tests: deadline −1 s / 0 / +1 s, wrong signer / PDA / destination, replay, double payout</li>
    <li>9 SDK tests · 2 Playwright browser tests on a local validator</li>
    <li>Devnet demo: paid path, refund path, 4 expected rejections</li>
    <li>2 offline Codex reviews; findings fixed in the repo</li></ul>
    <p class="small">github.com/Zhuoli/clauselock → README → Devnet status</p>`),
  d_close: page(`<h2>Trade-offs and next steps</h2><ul>
    <li>Native SOL only (SPL/USDC next)</li><li>One invited contributor per escrow (no squatting)</li>
    <li>Upgrade authority retained and disclosed until the reviewed release is frozen</li>
    <li>Next: milestones, multiple contributors, audit, bounty-board pilot</li></ul>
    <p class="small">Apache-2.0 · github.com/Zhuoli/clauselock</p>`),
}
