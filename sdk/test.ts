// Off-chain tests: TS terms hash vs the Python vectors, Fine Print gate, doc/chain check, explainers.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {Keypair, PublicKey} from '@solana/web3.js'
import {termsPreimage, termsHash, explain, type Escrow} from './index.ts'
import {compileTerms, canonicalJson, checkDocAgainstChain, digestHex, type Packet} from '../fineprint/adapter.ts'

let n = 0
const t = (name: string, f: () => void) => { f(); n++; console.log('ok -', name) }

t('terms hash matches cross-language vectors', () => {
  const v = JSON.parse(readFileSync(new URL('../vectors/terms-hash-v1.json', import.meta.url), 'utf8'))
  for (const c of v.cases) {
    const terms = {sponsor: new PublicKey(Buffer.from(c.sponsor_hex, 'hex')), contributor: new PublicKey(Buffer.from(c.contributor_hex, 'hex')),
      escrowId: BigInt(c.escrow_id), amount: BigInt(c.amount), acceptBy: BigInt(c.accept_by), submitBy: BigInt(c.submit_by),
      reviewBy: BigInt(c.review_by), refundPolicy: c.refund_policy, docDigest: Buffer.from(c.doc_digest_hex, 'hex')}
    assert.equal(termsPreimage(terms).toString('hex'), c.preimage_hex, c.name)
    assert.equal(termsHash(terms).toString('hex'), c.terms_hash_hex, c.name)
    assert.equal(terms.sponsor.toBase58(), c.sponsor)
  }
})

t('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({b: 1, a: {d: [1, 'x'], c: true}}), '{"a":{"c":true,"d":[1,"x"]},"b":1}')
  assert.equal(digestHex({a: 1, b: 2}), digestHex({b: 2, a: 1}))
})

const packet: Packet = JSON.parse(readFileSync(new URL('../fineprint/demo-bounty.packet.json', import.meta.url), 'utf8'))
const sponsor = Keypair.generate().publicKey.toBase58(), contributor = Keypair.generate().publicKey.toBase58()

t('open conflict blocks the terms; sponsor resolution unblocks', () => {
  const r = compileTerms({packet, sponsor, contributor, escrowId: '1'})
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.issues.some((i) => i.kind === 'conflict' && i.clauses.includes('clause.demo.deadline.listing')))
  const r2 = compileTerms({packet, sponsor, contributor, escrowId: '1', resolutions: [{conflict: 'conflict.demo.deadline', winningClaim: 'clause.demo.deadline.terms', resolvedBy: 'sponsor'}]})
  assert.ok(r2.ok)
  if (r2.ok) {
    assert.equal(r2.doc.submit_by_iso, '2026-10-13T06:59:59.000Z')
    assert.equal(r2.doc.field_clauses.submit_by, 'clause.demo.deadline.terms')
    assert.equal(r2.doc.amount_lamports, '1000000000')
  }
})

t('missing field and unresolved silent disagreement are reported', () => {
  const p2: Packet = structuredClone(packet)
  p2.clauses = p2.clauses.filter((c) => c._id !== 'clause.demo.review')
  p2.conflicts = []
  const r = compileTerms({packet: p2, sponsor, contributor, escrowId: '1'})
  assert.ok(!r.ok && r.issues.some((i) => i.kind === 'missing' && i.field === 'review_by'))
  assert.ok(!r.ok && r.issues.some((i) => i.kind === 'conflict' && i.field === 'submit_by'), 'disagreement found even without a conflict record')
})

t('doc vs chain mismatch is caught before signing', () => {
  const r = compileTerms({packet, sponsor, contributor, escrowId: '1', resolutions: [{conflict: 'conflict.demo.deadline', winningClaim: 'clause.demo.deadline.terms', resolvedBy: 'sponsor'}]})
  assert.ok(r.ok); if (!r.ok) return
  const chain = {sponsor, contributor, escrowId: '1', amount: r.doc.amount_lamports, acceptBy: r.doc.accept_by, submitBy: r.doc.submit_by, reviewBy: r.doc.review_by, refundPolicy: 0, docDigestHex: r.digest}
  assert.deepEqual(checkDocAgainstChain(r.doc, chain), [])
  const bad = checkDocAgainstChain(r.doc, {...chain, submitBy: String(Number(chain.submitBy) + 172800)})
  assert.ok(bad.some((e) => e.startsWith('submit_by')))
  const tampered = {...r.doc, submit_by_iso: '2026-10-15T06:59:59.000Z'}
  assert.ok(checkDocAgainstChain(tampered, chain).some((e) => e.includes('digest')))
})

t('explainers cite clauses and follow the on-chain predicates', () => {
  const e = {sponsor: Keypair.generate().publicKey, contributor: Keypair.generate().publicKey, escrowId: 1n, amount: 10n ** 9n,
    acceptBy: 100n, submitBy: 200n, reviewBy: 300n, refundPolicy: 0, docDigest: Buffer.alloc(32), schemaVersion: 1, bump: 255,
    termsHash: Buffer.alloc(32), evidenceHash: Buffer.alloc(32), state: 'Submitted', createdAt: 0n, acceptedAt: 0n, submittedAt: 0n,
    approvedAt: 0n, settledAt: 0n, settledBy: PublicKey.default} as Escrow
  const cm = {review_by: 'clause.demo.review', refund_policy: 'clause.demo.refund'}
  let v = explain(e, 299n, 'refund', cm)
  assert.equal(v.allowed, false); assert.deepEqual(v.clauses, ['clause.demo.review', 'clause.demo.refund'])
  assert.equal(explain(e, 300n, 'refund', cm).allowed, true)
  assert.equal(explain(e, 299n, 'approve', cm).allowed, true)
  assert.equal(explain(e, 300n, 'approve', cm).allowed, false)
  assert.equal(explain({...e, state: 'Approved'}, 10n ** 6n, 'refund', cm).allowed, false)
  assert.equal(explain({...e, state: 'Funded'}, 99n, 'accept', cm, e.sponsor).allowed, false)
  v = explain({...e, state: 'Funded'}, 100n, 'refund', cm); assert.equal(v.allowed, true)
})

t('adapter rejects ambiguous instants, non-discretionary promises, wrong wallet, bad amounts', () => {
  const resolve = [{conflict: 'conflict.demo.deadline', winningClaim: 'clause.demo.deadline.terms', resolvedBy: 'sponsor' as const}]
  const mut = (f: (p: Packet) => void) => { const p: Packet = structuredClone(packet); f(p); return compileTerms({packet: p, sponsor, contributor, escrowId: '1', resolutions: resolve}) }
  const issueOn = (r: ReturnType<typeof compileTerms>, field: string) => !r.ok && r.issues.some((i) => i.field === field)
  assert.ok(issueOn(mut((p) => { p.clauses.find((c) => c._id === 'clause.demo.accept')!.normalized!.instant = '2026-10-05T23:59:59' }), 'accept_by'), 'timezone-free instant')
  assert.ok(issueOn(mut((p) => { p.clauses.find((c) => c._id === 'clause.demo.accept')!.normalized!.instant = '2026-02-30T00:00:00Z' }), 'accept_by'), 'Feb 30')
  assert.ok(mut((p) => { p.clauses.find((c) => c._id === 'clause.demo.accept')!.normalized!.instant = '2026-10-05T23:59:59-07:00' }).ok, 'explicit offset ok')
  assert.ok(issueOn(mut((p) => { p.clauses.find((c) => c._id === 'clause.demo.discretion')!.normalized!.sponsorDiscretion = false }), 'discretion'))
  assert.ok(issueOn(mut((p) => { p.clauses.find((c) => c._id === 'clause.demo.contributor')!.normalized!.wallet = sponsor }), 'contributor'))
  assert.ok(mut((p) => { p.clauses.find((c) => c._id === 'clause.demo.contributor')!.normalized!.wallet = contributor }).ok)
  assert.ok(issueOn(mut((p) => { p.clauses.find((c) => c._id === 'clause.demo.reward')!.normalized!.lamports = '1.5' }), 'amount'))
  assert.ok(issueOn(mut((p) => { p.clauses.find((c) => c._id === 'clause.demo.reward')!.normalized!.lamports = '18446744073709551616' }), 'amount'))
  const r = compileTerms({packet, sponsor, contributor, escrowId: '-1', resolutions: resolve})
  assert.ok(issueOn(r, 'escrow_id'))
})

t('inconsistent ISO label is caught even if its digest was committed', () => {
  const r = compileTerms({packet, sponsor, contributor, escrowId: '1', resolutions: [{conflict: 'conflict.demo.deadline', winningClaim: 'clause.demo.deadline.terms', resolvedBy: 'sponsor'}]})
  assert.ok(r.ok); if (!r.ok) return
  const lying = {...r.doc, accept_by_iso: '2099-01-01T00:00:00.000Z'}
  const chain = {sponsor, contributor, escrowId: '1', amount: r.doc.amount_lamports, acceptBy: r.doc.accept_by, submitBy: r.doc.submit_by, reviewBy: r.doc.review_by, refundPolicy: 0, docDigestHex: digestHex(lying)}
  assert.ok(checkDocAgainstChain(lying, chain).some((e) => e.startsWith('accept_by_iso')))
})

t('SDK refuses out-of-range u8 / unsupported policy', () => {
  const base = {sponsor: PublicKey.default, contributor: PublicKey.default, escrowId: 1n, amount: 1n, acceptBy: 1n, submitBy: 2n, reviewBy: 3n, docDigest: Buffer.alloc(32)}
  assert.throws(() => termsPreimage({...base, refundPolicy: 256}))
  assert.throws(() => termsPreimage({...base, escrowId: 1n << 64n, refundPolicy: 0}))
})

console.log(`\n${n} passed`)
