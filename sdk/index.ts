/**
 * ClauseLock TypeScript client SDK (dependency: @solana/web3.js v1 only).
 * - PDA derivation, terms-hash commitment (byte-for-byte identical to the program),
 * - instruction builders, account decoder,
 * - deterministic `can*` explainers that cite the terms clauses behind every verdict.
 */
import {sha256 as nobleSha256} from '@noble/hashes/sha2.js'
import {Buffer} from 'buffer'
import {PublicKey, SystemProgram, TransactionInstruction} from '@solana/web3.js'

export const PROGRAM_ID = new PublicKey((typeof process !== 'undefined' && process.env?.CLAUSELOCK_PROGRAM_ID) || 'B5qem1S6padkAWwpAYzHeNDjnPHN6NHdmWRuacgvdgDu')
export const SCHEMA_VERSION = 1
export const MIN_AMOUNT = 1_000_000n
export const REFUND_TO_SPONSOR_ON_EXPIRY = 0
const TERMS_DOMAIN = Buffer.from('CLAUSELOCK_TERMS_V1')

/** Isomorphic (Node + browser) SHA-256 returning a Buffer. */
export const sha256 = (b: Uint8Array | string) => Buffer.from(nobleSha256(typeof b === 'string' ? new TextEncoder().encode(b) : b))
const disc = (name: string) => sha256(`global:${name}`).subarray(0, 8)
const ACCOUNT_DISC = sha256('account:Escrow').subarray(0, 8)

const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b } // throws if out of range
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b }
const u8 = (n: number) => { if (!Number.isInteger(n) || n < 0 || n > 255) throw new RangeError(`u8 out of range: ${n}`); return Buffer.from([n]) }
const b32 = (x: Uint8Array) => { if (x.length !== 32) throw new Error('expected 32 bytes'); return Buffer.from(x) }

export type Terms = {
  sponsor: PublicKey
  contributor: PublicKey
  escrowId: bigint
  amount: bigint // lamports
  acceptBy: bigint // unix seconds
  submitBy: bigint
  reviewBy: bigint
  refundPolicy: number
  docDigest: Uint8Array // sha256 of canonical terms JSON
}

export function termsPreimage(t: Terms, schemaVersion = SCHEMA_VERSION): Buffer {
  if (t.refundPolicy !== REFUND_TO_SPONSOR_ON_EXPIRY) throw new RangeError(`unsupported refund policy ${t.refundPolicy}`)
  return Buffer.concat([
    TERMS_DOMAIN, u8(schemaVersion), t.sponsor.toBuffer(), t.contributor.toBuffer(),
    u64(t.escrowId), u64(t.amount), i64(t.acceptBy), i64(t.submitBy), i64(t.reviewBy),
    u8(t.refundPolicy), b32(t.docDigest),
  ])
}
export const termsHash = (t: Terms) => sha256(termsPreimage(t))

export function escrowPda(sponsor: PublicKey, escrowId: bigint, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('escrow'), sponsor.toBuffer(), u64(escrowId)], programId)[0]
}

// ---------- instructions ----------
const ix = (keys: {pubkey: PublicKey; isSigner: boolean; isWritable: boolean}[], data: Buffer, programId = PROGRAM_ID) =>
  new TransactionInstruction({programId, keys, data})

export function createFundIx(t: Terms, programId = PROGRAM_ID) {
  const escrow = escrowPda(t.sponsor, t.escrowId, programId)
  const data = Buffer.concat([
    disc('create_fund'), u64(t.escrowId), t.contributor.toBuffer(), u64(t.amount),
    i64(t.acceptBy), i64(t.submitBy), i64(t.reviewBy), u8(t.refundPolicy), b32(t.docDigest),
  ])
  return ix([
    {pubkey: t.sponsor, isSigner: true, isWritable: true},
    {pubkey: escrow, isSigner: false, isWritable: true},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
  ], data, programId)
}
const two = (signer: PublicKey, escrow: PublicKey) => [
  {pubkey: signer, isSigner: true, isWritable: false},
  {pubkey: escrow, isSigner: false, isWritable: true},
]
export const acceptIx = (contributor: PublicKey, escrow: PublicKey, expectedTermsHash: Uint8Array, programId = PROGRAM_ID) =>
  ix(two(contributor, escrow), Buffer.concat([disc('accept'), b32(expectedTermsHash)]), programId)
export const submitEvidenceIx = (contributor: PublicKey, escrow: PublicKey, evidenceHash: Uint8Array, programId = PROGRAM_ID) =>
  ix(two(contributor, escrow), Buffer.concat([disc('submit_evidence'), b32(evidenceHash)]), programId)
export const approveIx = (sponsor: PublicKey, escrow: PublicKey, programId = PROGRAM_ID) =>
  ix(two(sponsor, escrow), disc('approve'), programId)
export const cancelIx = (sponsor: PublicKey, escrow: PublicKey, programId = PROGRAM_ID) =>
  ix([{pubkey: sponsor, isSigner: true, isWritable: true}, {pubkey: escrow, isSigner: false, isWritable: true}], disc('cancel'), programId)
export const finalizePaymentIx = (caller: PublicKey, escrow: PublicKey, contributor: PublicKey, programId = PROGRAM_ID) =>
  ix([...two(caller, escrow), {pubkey: contributor, isSigner: false, isWritable: true}], disc('finalize_payment'), programId)
export const sweepExcessIx = (caller: PublicKey, escrow: PublicKey, sponsor: PublicKey, programId = PROGRAM_ID) =>
  ix([...two(caller, escrow), {pubkey: sponsor, isSigner: false, isWritable: true}], disc('sweep_excess'), programId)
export const finalizeRefundIx = (caller: PublicKey, escrow: PublicKey, sponsor: PublicKey, programId = PROGRAM_ID) =>
  ix([...two(caller, escrow), {pubkey: sponsor, isSigner: false, isWritable: true}], disc('finalize_refund'), programId)

// ---------- account ----------
export const STATES = ['Funded', 'Accepted', 'Submitted', 'Approved', 'Paid', 'Refunded'] as const
export type EscrowState = (typeof STATES)[number]
export type Escrow = Terms & {
  schemaVersion: number; bump: number; termsHash: Buffer; evidenceHash: Buffer; state: EscrowState
  createdAt: bigint; acceptedAt: bigint; submittedAt: bigint; approvedAt: bigint; settledAt: bigint; settledBy: PublicKey
}

export const ESCROW_ACCOUNT_SIZE = 284
export function decodeEscrow(data: Buffer): Escrow {
  if (data.length !== ESCROW_ACCOUNT_SIZE) throw new Error(`unexpected Escrow size ${data.length}`)
  if (!data.subarray(0, 8).equals(ACCOUNT_DISC)) throw new Error('not a ClauseLock Escrow account')
  if (data[8] !== SCHEMA_VERSION) throw new Error(`unsupported schema version ${data[8]}`)
  if (data[211] >= STATES.length) throw new Error(`invalid state byte ${data[211]}`)
  let o = 8
  const r8 = () => data[o++]
  const rU64 = () => { const v = data.readBigUInt64LE(o); o += 8; return v }
  const rI64 = () => { const v = data.readBigInt64LE(o); o += 8; return v }
  const rB = () => { const v = Buffer.from(data.subarray(o, o + 32)); o += 32; return v }
  const rPk = () => new PublicKey(rB())
  const schemaVersion = r8(), bump = r8(), escrowId = rU64(), sponsor = rPk(), contributor = rPk(), amount = rU64()
  const acceptBy = rI64(), submitBy = rI64(), reviewBy = rI64(), refundPolicy = r8()
  const docDigest = rB(), termsHash_ = rB(), evidenceHash = rB(), state = STATES[r8()]
  const createdAt = rI64(), acceptedAt = rI64(), submittedAt = rI64(), approvedAt = rI64(), settledAt = rI64(), settledBy = rPk()
  return {schemaVersion, bump, escrowId, sponsor, contributor, amount, acceptBy, submitBy, reviewBy, refundPolicy,
    docDigest, termsHash: termsHash_, evidenceHash, state, createdAt, acceptedAt, submittedAt, approvedAt, settledAt, settledBy}
}

export const ERRORS = ['BadDeadlines', 'AmountTooSmall', 'BadContributor', 'BadRefundPolicy', 'WrongState', 'TermsMismatch',
  'DeadlinePassed', 'RefundNotYetAvailable', 'ApprovedCannotRefund', 'EmptyEvidence', 'InsufficientEscrowBalance', 'NothingToSweep'] as const
/** Pull the Anchor error name out of a failed transaction's logs. */
export function anchorErrorFromLogs(logs: string[] | null | undefined): string | null {
  for (const l of logs ?? []) { const m = l.match(/Error Code: (\w+)/); if (m) return m[1] }
  return null
}

/** Fetch-side check: the account must be owned by ClauseLock and sit at the PDA its own fields imply. */
export function decodeVerifiedEscrow(address: PublicKey, info: {owner: PublicKey; data: Buffer}, programId = PROGRAM_ID): Escrow {
  if (!info.owner.equals(programId)) throw new Error(`escrow owned by ${info.owner.toBase58()}, not ClauseLock`)
  const e = decodeEscrow(info.data)
  if (!escrowPda(e.sponsor, e.escrowId, programId).equals(address)) throw new Error('escrow address does not match its sponsor/escrow_id PDA')
  return e
}

// ---------- deterministic explanations ----------
export type Verdict = {action: string; allowed: boolean; reason: string; clauses: string[]; onchain: Record<string, string>}
/** Map from executable field to the terms-document clause id that set it (from the canonical terms doc). */
export type ClauseMap = Partial<Record<'amount' | 'accept_by' | 'submit_by' | 'review_by' | 'refund_policy' | 'contributor' | 'discretion', string>>

const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString().replace('.000Z', 'Z')
export function fmtTime(t: bigint, tz = 'America/Los_Angeles') {
  const d = new Date(Number(t) * 1000)
  return `${d.toLocaleString('en-US', {timeZone: tz, dateStyle: 'medium', timeStyle: 'long'})} (${iso(t)})`
}

export function explain(e: Escrow, now: bigint, action: 'accept' | 'submit' | 'approve' | 'pay' | 'refund' | 'cancel', cm: ClauseMap = {}, who?: PublicKey): Verdict {
  const c = (...k: (keyof ClauseMap)[]) => k.map((x) => cm[x]).filter(Boolean) as string[]
  const on = {state: e.state, now: iso(now), accept_by: iso(e.acceptBy), submit_by: iso(e.submitBy), review_by: iso(e.reviewBy)}
  const v = (allowed: boolean, reason: string, clauses: string[]): Verdict => ({action, allowed, reason, clauses, onchain: on})
  const notWho = (role: 'sponsor' | 'contributor') => who && !who.equals(role === 'sponsor' ? e.sponsor : e.contributor)
  switch (action) {
    case 'accept':
      if (notWho('contributor')) return v(false, `Only the invited contributor ${e.contributor.toBase58()} can accept.`, c('contributor'))
      if (e.state !== 'Funded') return v(false, `Escrow is ${e.state}; acceptance is only possible while Funded.`, [])
      if (now >= e.acceptBy) return v(false, `Acceptance closed at ${fmtTime(e.acceptBy)} (now >= accept_by).`, c('accept_by'))
      return v(true, `Open until ${fmtTime(e.acceptBy)}. You must sign terms hash ${e.termsHash.toString('hex')}.`, c('accept_by', 'amount', 'refund_policy', 'discretion'))
    case 'submit':
      if (notWho('contributor')) return v(false, 'Only the invited contributor can submit evidence.', c('contributor'))
      if (e.state !== 'Accepted') return v(false, `Escrow is ${e.state}; evidence can only be submitted once, after acceptance.`, [])
      if (now >= e.submitBy) return v(false, `Submission closed at ${fmtTime(e.submitBy)}.`, c('submit_by'))
      return v(true, `Submit evidence before ${fmtTime(e.submitBy)}.`, c('submit_by'))
    case 'approve':
      if (notWho('sponsor')) return v(false, 'Only the sponsor can approve.', [])
      if (e.state !== 'Submitted') return v(false, `Escrow is ${e.state}; approval requires a submission.`, [])
      if (now >= e.reviewBy) return v(false, `Review window closed at ${fmtTime(e.reviewBy)}; the reward is now refundable to the sponsor.`, c('review_by', 'refund_policy'))
      return v(true, `Sponsor may approve until ${fmtTime(e.reviewBy)}. Approval is irrevocable.`, c('review_by', 'discretion'))
    case 'pay':
      if (e.state === 'Paid') return v(false, 'Already paid.', [])
      if (e.state !== 'Approved') return v(false, `Payment requires sponsor approval; escrow is ${e.state}.`, c('discretion'))
      return v(true, `Anyone may send the reward to ${e.contributor.toBase58()} (the fee payer is whoever submits the transaction).`, c('amount', 'contributor'))
    case 'cancel':
      if (notWho('sponsor')) return v(false, 'Only the sponsor can cancel.', [])
      if (e.state !== 'Funded') return v(false, `Cancel is only possible before the contributor accepts; escrow is ${e.state}.`, [])
      return v(true, 'No one has accepted yet, so the sponsor may withdraw the offer.', [])
    case 'refund': {
      const gov = {Funded: ['accept_by', e.acceptBy, 'nobody accepted'], Accepted: ['submit_by', e.submitBy, 'no evidence was submitted'],
        Submitted: ['review_by', e.reviewBy, 'the sponsor did not approve']} as const
      if (e.state === 'Approved') return v(false, 'The sponsor approved the work; an approved escrow can never be refunded.', c('refund_policy'))
      if (e.state === 'Paid' || e.state === 'Refunded') return v(false, `Already settled (${e.state}).`, [])
      const [field, t, why] = gov[e.state]
      if (now < t) return v(false, `Refund opens at ${fmtTime(t)} if ${why} by ${field}; it is ${e.state} now.`, c(field as keyof ClauseMap, 'refund_policy'))
      return v(true, `${field} passed (${fmtTime(t)}) and ${why}: anyone may return the reward to the sponsor.`, c(field as keyof ClauseMap, 'refund_policy'))
    }
  }
}
