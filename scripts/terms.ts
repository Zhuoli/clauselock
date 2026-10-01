/**
 * ClauseLock CLI.
 *   npm run terms -- compile --packet fineprint/demo-bounty.packet.json --sponsor <pk> --contributor <pk> --escrow-id 1 \
 *                    [--resolve conflict.demo.deadline=clause.demo.deadline.terms] [--out terms.json]
 *   npm run terms -- inspect --escrow <pda> [--cluster localnet|devnet|<url>] [--terms terms.json]
 */
import {readFileSync, writeFileSync} from 'node:fs'
import {Connection, PublicKey} from '@solana/web3.js'
import * as cl from '../sdk/index.ts'
import {compileTerms, checkDocAgainstChain, type Packet, type TermsDoc} from '../fineprint/adapter.ts'

const [cmd] = process.argv.slice(2)
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const args = (k: string) => process.argv.flatMap((a, i) => (a === `--${k}` ? [process.argv[i + 1]] : []))

async function main() {
  if (cmd === 'compile') {
    const packet: Packet = JSON.parse(readFileSync(arg('packet') ?? 'fineprint/demo-bounty.packet.json', 'utf8'))
    const resolutions = args('resolve').map((r) => { const [conflict, winningClaim] = r.split('='); return {conflict, winningClaim, resolvedBy: 'sponsor' as const} })
    const r = compileTerms({packet, sponsor: arg('sponsor')!, contributor: arg('contributor')!, escrowId: arg('escrow-id') ?? '1', resolutions})
    if (!r.ok) {
      console.log('BLOCKED: the sponsor cannot fund until these are fixed.\n')
      for (const i of r.issues) { console.log(`[${i.kind}] ${i.field}: ${i.message}`); for (const q of i.quotes) console.log(`   - ${q.source} (${q.url}): "${q.quote}"  [${q.clause}]`) }
      process.exit(2)
    }
    const out = arg('out'); if (out) writeFileSync(out, JSON.stringify(r.doc, null, 2))
    console.log(JSON.stringify({doc_digest: r.digest, amount_lamports: r.doc.amount_lamports, accept_by: r.doc.accept_by_iso, submit_by: r.doc.submit_by_iso,
      review_by: r.doc.review_by_iso, field_clauses: r.doc.field_clauses, resolutions: r.doc.resolutions, written: out ?? null}, null, 2))
    return
  }
  if (cmd === 'inspect') {
    const c = arg('cluster') ?? 'localnet'
    const conn = new Connection(c === 'devnet' ? 'https://api.devnet.solana.com' : c === 'localnet' ? 'http://127.0.0.1:8899' : c, 'confirmed')
    const pda = new PublicKey(arg('escrow')!)
    const acc = await conn.getAccountInfo(pda)
    if (!acc) throw new Error('escrow not found')
    const e = cl.decodeVerifiedEscrow(pda, acc)
    const now = BigInt((await conn.getBlockTime(await conn.getSlot())) ?? Math.floor(Date.now() / 1000))
    const recomputed = cl.termsHash(e)
    console.log(`escrow ${pda.toBase58()}  state=${e.state}  amount=${e.amount} lamports  balance=${acc.lamports}`)
    console.log(`sponsor ${e.sponsor.toBase58()}  contributor ${e.contributor.toBase58()}`)
    for (const [k, t] of [['accept_by', e.acceptBy], ['submit_by', e.submitBy], ['review_by', e.reviewBy]] as const) console.log(`${k.padEnd(9)} ${cl.fmtTime(t)}`)
    console.log(`terms_hash ${e.termsHash.toString('hex')} (${recomputed.equals(e.termsHash) ? 'recomputed from on-chain fields: OK' : 'MISMATCH'})`)
    let cm = {}
    const tf = arg('terms')
    if (tf) {
      const doc: TermsDoc = JSON.parse(readFileSync(tf, 'utf8'))
      const errs = checkDocAgainstChain(doc, {sponsor: e.sponsor.toBase58(), contributor: e.contributor.toBase58(), escrowId: e.escrowId.toString(), amount: e.amount.toString(),
        acceptBy: e.acceptBy.toString(), submitBy: e.submitBy.toString(), reviewBy: e.reviewBy.toString(), refundPolicy: e.refundPolicy, docDigestHex: Buffer.from(e.docDigest).toString('hex')})
      console.log(errs.length ? `terms document DOES NOT MATCH: ${errs.join('; ')}` : 'terms document matches the chain (digest + every field)')
      cm = doc.field_clauses
    }
    console.log(`\ncluster time ${cl.fmtTime(now)}`)
    for (const a of ['accept', 'submit', 'approve', 'pay', 'refund', 'cancel'] as const) {
      const v = cl.explain(e, now, a, cm)
      console.log(`can_${a.padEnd(7)} ${v.allowed ? 'YES' : 'no '}  ${v.reason}${v.clauses.length ? `  [${v.clauses.join(', ')}]` : ''}`)
    }
    return
  }
  console.log('usage: terms compile|inspect ... (see header of scripts/terms.ts)')
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
