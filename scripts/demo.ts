/**
 * End-to-end ClauseLock demo against a live cluster (local validator or devnet).
 *   npm run demo                         # http://127.0.0.1:8899, airdrops test SOL
 *   npm run demo -- --cluster devnet     # funds demo wallets from ~/.config/solana/id.json (no airdrop loop)
 *
 * Story: Fine Print blocks a terms conflict -> sponsor resolves -> escrow A is funded, accepted,
 * submitted, approved, and paid out by a third wallet. A tampered terms hash is rejected.
 * Escrow B is never accepted, and is refunded once accept_by passes, with an explanation.
 *
 * Deadlines are shortened to seconds ("demo speed"); the quotes are annotated so nobody mistakes them for the real dates.
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {homedir} from 'node:os'
import {Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction} from '@solana/web3.js'
import * as cl from '../sdk/index.ts'
import {compileTerms, checkDocAgainstChain, type Packet} from '../fineprint/adapter.ts'

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const cluster = arg('cluster', 'localnet')!
const url = cluster === 'devnet' ? 'https://api.devnet.solana.com' : cluster === 'localnet' ? 'http://127.0.0.1:8899' : cluster
const conn = new Connection(url, 'confirmed')
const REWARD = BigInt(arg('reward-lamports', cluster === 'devnet' ? String(0.05 * LAMPORTS_PER_SOL) : String(LAMPORTS_PER_SOL))!)
const receipts: any[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...a: any[]) => console.log(...a)
const h = (s: string) => log(`\n=== ${s} ===`)
const explorer = (sig: string) => cluster === 'devnet' ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : sig

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, {commitment: 'confirmed'})
  receipts.push({label, sig, feePayer: signers[0].publicKey.toBase58()})
  log(`  ✓ ${label}: ${explorer(sig)}`)
  return sig
}
async function expectFail(label: string, ixs: TransactionInstruction[], signers: Keypair[], want: string) {
  try { await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, {commitment: 'confirmed', skipPreflight: false}) }
  catch (e: any) {
    const logs = e.logs ?? (typeof e.getLogs === 'function' ? await e.getLogs(conn).catch(() => null) : null)
    const got = cl.anchorErrorFromLogs(logs) ?? String(e.message).slice(0, 120)
    if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
    log(`  ✗ ${label}: rejected by the program with ${got} (as expected)`); receipts.push({label, rejectedWith: got}); return
  }
  throw new Error(`${label}: unexpectedly succeeded`)
}
const fetchEscrow = async (pda: PublicKey) => cl.decodeVerifiedEscrow(pda, (await conn.getAccountInfo(pda, 'confirmed'))!)
const chainNow = async () => BigInt((await conn.getBlockTime(await conn.getSlot('confirmed'))) ?? Math.floor(Date.now() / 1000))
async function waitUntilChain(t: bigint) { while ((await chainNow()) < t) await sleep(1000) }

async function fund(kps: Keypair[], lamports: number) {
  if (cluster === 'localnet') {
    for (const k of kps) { const s = await conn.requestAirdrop(k.publicKey, lamports); await conn.confirmTransaction(s, 'confirmed') }
    return
  }
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))))
  await send('fund demo wallets from deployer', kps.map((k) => SystemProgram.transfer({fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports})), [payer])
}

function demoSpeedPacket(packet: Packet, now: number, offsets: Record<string, number>): Packet {
  const p: Packet = structuredClone(packet)
  for (const c of p.clauses) {
    const f = c.normalized?.field as string
    if (f in offsets) { c.normalized!.instant = new Date((now + offsets[f]) * 1000).toISOString(); c.quote += ` [demo speed: now+${offsets[f]}s]` }
    if (f === 'amount') { c.normalized!.lamports = REWARD.toString(); c.quote += ` [demo amount: ${Number(REWARD) / LAMPORTS_PER_SOL} SOL]` }
  }
  return p
}

async function main() {
  log(`ClauseLock demo on ${cluster} (${url}); program ${cl.PROGRAM_ID.toBase58()}`)
  const info = await conn.getAccountInfo(cl.PROGRAM_ID)
  if (!info?.executable) throw new Error('program not deployed on this cluster')
  const sponsor = Keypair.generate(), contributor = Keypair.generate(), third = Keypair.generate()
  const perWallet = cluster === 'localnet' ? 5 * LAMPORTS_PER_SOL : Number(REWARD) * 2 + 0.01 * LAMPORTS_PER_SOL
  await fund([sponsor], perWallet)
  await fund([contributor, third], cluster === 'localnet' ? LAMPORTS_PER_SOL : 0.003 * LAMPORTS_PER_SOL)
  log(`  sponsor ${sponsor.publicKey.toBase58()}\n  contributor ${contributor.publicKey.toBase58()}\n  third party ${third.publicKey.toBase58()}`)

  const base: Packet = JSON.parse(readFileSync(new URL('../fineprint/demo-bounty.packet.json', import.meta.url), 'utf8'))
  const now = Number(await chainNow())
  const packet = demoSpeedPacket(base, now, {accept_by: 40, submit_by: 70, review_by: 100})
  const escrowIdA = BigInt(Date.now())

  h('1. Fine Print reads the rule packet')
  const blocked = compileTerms({packet, sponsor: sponsor.publicKey.toBase58(), contributor: contributor.publicKey.toBase58(), escrowId: escrowIdA.toString()})
  if (blocked.ok) throw new Error('expected the conflict gate to block')
  for (const i of blocked.issues) { log(`  BLOCKED [${i.kind}] ${i.field}: ${i.message}`); for (const q of i.quotes) log(`     - ${q.source}: "${q.quote}" (${q.clause})`) }

  h('2. Sponsor resolves: the Terms govern')
  const res = compileTerms({packet, sponsor: sponsor.publicKey.toBase58(), contributor: contributor.publicKey.toBase58(), escrowId: escrowIdA.toString(),
    resolutions: [{conflict: 'conflict.demo.deadline', winningClaim: 'clause.demo.deadline.terms', resolvedBy: 'sponsor', note: 'Terms govern per precedence clause.'}]})
  if (!res.ok) throw new Error(JSON.stringify(res.issues))
  const doc = res.doc
  mkdirSync('receipts', {recursive: true})
  writeFileSync(`receipts/terms-${escrowIdA}.json`, JSON.stringify(doc, null, 2))
  log(`  terms document digest ${res.digest}  (receipts/terms-${escrowIdA}.json)`)
  const terms: cl.Terms = {sponsor: sponsor.publicKey, contributor: contributor.publicKey, escrowId: escrowIdA, amount: BigInt(doc.amount_lamports),
    acceptBy: BigInt(doc.accept_by), submitBy: BigInt(doc.submit_by), reviewBy: BigInt(doc.review_by), refundPolicy: cl.REFUND_TO_SPONSOR_ON_EXPIRY,
    docDigest: Buffer.from(res.digest, 'hex')}
  const cm = doc.field_clauses

  h('3. Sponsor funds escrow A')
  const pdaA = cl.escrowPda(sponsor.publicKey, escrowIdA)
  await send('create_fund', [cl.createFundIx(terms)], [sponsor])
  let e = await fetchEscrow(pdaA)
  log(`  escrow ${pdaA.toBase58()} state=${e.state} amount=${Number(e.amount) / LAMPORTS_PER_SOL} SOL; balance=${(await conn.getBalance(pdaA)) / LAMPORTS_PER_SOL} SOL (reward + rent)`)
  log(`  on-chain terms_hash ${e.termsHash.toString('hex')}`)

  h('4. Contributor verifies, then accepts the exact hash')
  const mismatch = checkDocAgainstChain(doc, {sponsor: e.sponsor.toBase58(), contributor: e.contributor.toBase58(), escrowId: e.escrowId.toString(), amount: e.amount.toString(),
    acceptBy: e.acceptBy.toString(), submitBy: e.submitBy.toString(), reviewBy: e.reviewBy.toString(), refundPolicy: e.refundPolicy, docDigestHex: Buffer.from(e.docDigest).toString('hex')})
  if (mismatch.length) throw new Error('doc/chain mismatch: ' + mismatch.join('; '))
  const local = cl.termsHash(terms)
  log(`  document matches chain; locally recomputed terms_hash ${local.equals(e.termsHash) ? 'MATCHES' : 'DIFFERS'}`)
  log(`  can_accept: ${cl.explain(e, await chainNow(), 'accept', cm, contributor.publicKey).reason}`)
  const lie = cl.termsHash({...terms, submitBy: terms.submitBy + 2n * 86400n}) // what a UI showing "Oct 14" would have signed
  await expectFail('accept with the listing\'s later deadline', [cl.acceptIx(contributor.publicKey, pdaA, lie)], [contributor], 'TermsMismatch')
  await send('accept', [cl.acceptIx(contributor.publicKey, pdaA, e.termsHash)], [contributor])
  log('  (there is no instruction that edits amount, parties, or deadlines: see the IDL)')

  h('5. Submit evidence, approve, third party settles')
  const evidence = cl.sha256('https://example.org/my-escrow-explainer @ commit abc123')
  await send('submit_evidence', [cl.submitEvidenceIx(contributor.publicKey, pdaA, evidence)], [contributor])
  e = await fetchEscrow(pdaA)
  log(`  can_refund now? ${cl.explain(e, await chainNow(), 'refund', cm).reason}`)
  await send('approve', [cl.approveIx(sponsor.publicKey, pdaA)], [sponsor])
  await expectFail('refund after approval', [cl.finalizeRefundIx(third.publicKey, pdaA, sponsor.publicKey)], [third], 'ApprovedCannotRefund')
  const before = await conn.getBalance(contributor.publicKey)
  await send('finalize_payment (signed by third party)', [cl.finalizePaymentIx(third.publicKey, pdaA, contributor.publicKey)], [third])
  e = await fetchEscrow(pdaA)
  log(`  state=${e.state}; contributor +${((await conn.getBalance(contributor.publicKey)) - before) / LAMPORTS_PER_SOL} SOL; settled_by=${e.settledBy.toBase58()}`)
  await expectFail('second payout', [cl.finalizePaymentIx(third.publicKey, pdaA, contributor.publicKey)], [third], 'WrongState')

  h('6. Escrow B: nobody accepts, so it refunds after accept_by')
  const escrowIdB = escrowIdA + 1n
  const nowB = await chainNow()
  const resB = compileTerms({packet: demoSpeedPacket(base, Number(nowB), {accept_by: 15, submit_by: 30, review_by: 45}), sponsor: sponsor.publicKey.toBase58(),
    contributor: contributor.publicKey.toBase58(), escrowId: escrowIdB.toString(),
    resolutions: [{conflict: 'conflict.demo.deadline', winningClaim: 'clause.demo.deadline.terms', resolvedBy: 'sponsor'}]})
  if (!resB.ok) throw new Error(JSON.stringify(resB.issues))
  writeFileSync(`receipts/terms-${escrowIdB}.json`, JSON.stringify(resB.doc, null, 2))
  const termsB = {...terms, escrowId: escrowIdB, acceptBy: BigInt(resB.doc.accept_by), submitBy: BigInt(resB.doc.submit_by), reviewBy: BigInt(resB.doc.review_by), docDigest: Buffer.from(resB.digest, 'hex')}
  const pdaB = cl.escrowPda(sponsor.publicKey, escrowIdB)
  await send('create_fund (B)', [cl.createFundIx(termsB)], [sponsor])
  e = await fetchEscrow(pdaB)
  log(`  can_refund: ${cl.explain(e, await chainNow(), 'refund', cm).reason}`)
  await expectFail('early refund', [cl.finalizeRefundIx(third.publicKey, pdaB, sponsor.publicKey)], [third], 'RefundNotYetAvailable')
  log(`  waiting for the cluster clock to pass accept_by (${cl.fmtTime(termsB.acceptBy)})...`)
  await waitUntilChain(termsB.acceptBy + 1n)
  await sleep(1500)
  log(`  can_refund: ${cl.explain(e, await chainNow(), 'refund', cm).reason}`)
  const sb = await conn.getBalance(sponsor.publicKey)
  await send('finalize_refund (B, signed by third party)', [cl.finalizeRefundIx(third.publicKey, pdaB, sponsor.publicKey)], [third])
  log(`  state=${(await fetchEscrow(pdaB)).state}; sponsor +${((await conn.getBalance(sponsor.publicKey)) - sb) / LAMPORTS_PER_SOL} SOL`)

  const out = `receipts/${cluster}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(out, JSON.stringify({cluster, programId: cl.PROGRAM_ID.toBase58(), escrowA: pdaA.toBase58(), escrowB: pdaB.toBase58(),
    termsHashA: (await fetchEscrow(pdaA)).termsHash.toString('hex'), docDigestA: res.digest, receipts}, null, 2))
  log(`\nDone. Receipts: ${out}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
