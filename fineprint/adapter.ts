/**
 * Fine Print -> ClauseLock adapter.
 * Reuses Fine Print's content model (ruleSource / clause with verbatim quote + normalized JSON /
 * conflict with claims and resolution) from ../sanity-challenge. New here: the conflict gate,
 * the canonical terms document, and its digest.
 *
 * compileTerms() refuses to emit terms while any executable field is missing or contested.
 */
import {createHash} from 'node:crypto'

export type Clause = {_id: string; topic: string; source: string; quote: string; normalized?: Record<string, any> | null}
export type RuleSource = {_id: string; title: string; url: string; kind: string; precedenceRank: number; precedenceQuote?: string}
export type Conflict = {_id: string; topic: string; title: string; claims: string[]; status: 'open' | 'resolved'; winningClaim?: string; resolvedBy?: string; rationale: string; severity?: string}
export type Packet = {bounty: {_id: string; title: string; url: string}; ruleSources: RuleSource[]; clauses: Clause[]; conflicts: Conflict[]}

export const FIELDS = ['amount', 'contributor', 'accept_by', 'submit_by', 'review_by', 'refund_policy', 'discretion'] as const
export type Field = (typeof FIELDS)[number]
export type Issue = {kind: 'missing' | 'conflict' | 'invalid'; field: Field | string; message: string; clauses: string[]; quotes: {clause: string; source: string; url: string; quote: string}[]}

export type Resolution = {conflict: string; winningClaim: string; resolvedBy: 'sponsor' | 'precedence'; note?: string}
export type CompileInput = {packet: Packet; sponsor: string; contributor: string; escrowId: string; resolutions?: Resolution[]}

/** RFC 8785-style canonical JSON for our value domain (strings, safe ints, bools, arrays, objects). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new Error('canonical JSON: only safe integers'); return String(v) }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (typeof v === 'object') {
    return '{' + Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson((v as any)[k])).join(',') + '}'
  }
  throw new Error('canonical JSON: unsupported ' + typeof v)
}
export const digestHex = (doc: unknown) => createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex')

const toUnix = (iso: string) => { const t = Date.parse(iso); if (Number.isNaN(t)) throw new Error('bad instant ' + iso); return String(Math.floor(t / 1000)) }

export type TermsDoc = {
  schema: 'clauselock-terms/v1'
  bounty: Packet['bounty']
  parties: {sponsor: string; contributor: string}
  escrow_id: string
  amount_lamports: string
  accept_by: string; submit_by: string; review_by: string // unix seconds
  accept_by_iso: string; submit_by_iso: string; review_by_iso: string
  refund_policy: 'refund-to-sponsor-on-expiry'
  disclosures: string[]
  field_clauses: Record<Field, string>
  clauses: {id: string; source: string; url: string; quote: string}[]
  resolutions: {conflict: string; title: string; winningClaim: string; resolvedBy: string; note?: string}[]
}

export function compileTerms(input: CompileInput): {ok: true; doc: TermsDoc; digest: string; issues: Issue[]} | {ok: false; issues: Issue[]} {
  const {packet} = input
  const src = new Map(packet.ruleSources.map((s) => [s._id, s]))
  const byId = new Map(packet.clauses.map((c) => [c._id, c]))
  const q = (id: string) => { const c = byId.get(id)!; const s = src.get(c.source); return {clause: id, source: s?.title ?? c.source, url: s?.url ?? '', quote: c.quote} }
  const resolutions = new Map((input.resolutions ?? []).map((r) => [r.conflict, r]))
  const issues: Issue[] = []
  const chosen: Partial<Record<Field, string>> = {}

  // Settle conflicts first: a conflict is settled if already resolved in the packet, or resolved by the sponsor now.
  const losers = new Set<string>()
  const appliedResolutions: TermsDoc['resolutions'] = []
  for (const cf of packet.conflicts) {
    const r = resolutions.get(cf._id)
    const winner = r?.winningClaim ?? (cf.status === 'resolved' ? cf.winningClaim : undefined)
    if (!winner) {
      issues.push({kind: 'conflict', field: (byId.get(cf.claims[0])?.normalized?.field as string) ?? cf.topic,
        message: `${cf.title}. ${cf.rationale} Resolve with --resolve ${cf._id}=<clause id>.`, clauses: cf.claims, quotes: cf.claims.map(q)})
      continue
    }
    if (!cf.claims.includes(winner)) { issues.push({kind: 'invalid', field: cf.topic, message: `${winner} is not a claim of ${cf._id}`, clauses: cf.claims, quotes: []}); continue }
    cf.claims.filter((c) => c !== winner).forEach((c) => losers.add(c))
    appliedResolutions.push({conflict: cf._id, title: cf.title, winningClaim: winner, resolvedBy: r?.resolvedBy ?? cf.resolvedBy ?? 'precedence', note: r?.note})
  }
  const contested = new Set(issues.filter((i) => i.kind === 'conflict').flatMap((i) => i.clauses))

  for (const f of FIELDS) {
    const cands = packet.clauses.filter((c) => c.normalized?.field === f && !losers.has(c._id))
    if (cands.length === 0) { issues.push({kind: 'missing', field: f, message: `No clause sets "${f}". The sponsor must add it before funding.`, clauses: [], quotes: []}); continue }
    if (cands.some((c) => contested.has(c._id))) continue // already reported as a conflict
    const vals = new Set(cands.map((c) => canonicalJson({...c.normalized, precision: undefined})))
    if (vals.size > 1) {
      issues.push({kind: 'conflict', field: f, message: `Clauses disagree on "${f}" and no conflict record resolves it.`, clauses: cands.map((c) => c._id), quotes: cands.map((c) => q(c._id))})
      continue
    }
    chosen[f] = cands.sort((a, b) => (src.get(a.source)?.precedenceRank ?? 99) - (src.get(b.source)?.precedenceRank ?? 99))[0]._id
  }
  if (issues.length) return {ok: false, issues}

  const n = (f: Field) => byId.get(chosen[f]!)!.normalized!
  const [acceptBy, submitBy, reviewBy] = (['accept_by', 'submit_by', 'review_by'] as const).map((f) => toUnix(n(f).instant))
  const pol = n('refund_policy').policy
  if (pol !== 'refund-to-sponsor-on-expiry') issues.push({kind: 'invalid', field: 'refund_policy', message: `Unsupported refund policy "${pol}" (schema v1 supports only refund-to-sponsor-on-expiry).`, clauses: [chosen.refund_policy!], quotes: [q(chosen.refund_policy!)]})
  if (!(BigInt(acceptBy) < BigInt(submitBy) && BigInt(submitBy) < BigInt(reviewBy)))
    issues.push({kind: 'invalid', field: 'deadlines', message: 'Deadlines must be ordered accept_by < submit_by < review_by.', clauses: [chosen.accept_by!, chosen.submit_by!, chosen.review_by!], quotes: []})
  if (input.sponsor === input.contributor) issues.push({kind: 'invalid', field: 'contributor', message: 'Contributor must differ from sponsor.', clauses: [chosen.contributor!], quotes: []})
  if (issues.length) return {ok: false, issues}

  const used = FIELDS.map((f) => chosen[f]!)
  const doc: TermsDoc = {
    schema: 'clauselock-terms/v1',
    bounty: packet.bounty,
    parties: {sponsor: input.sponsor, contributor: input.contributor},
    escrow_id: input.escrowId,
    amount_lamports: String(n('amount').lamports),
    accept_by: acceptBy, submit_by: submitBy, review_by: reviewBy,
    accept_by_iso: new Date(Number(acceptBy) * 1000).toISOString(),
    submit_by_iso: new Date(Number(submitBy) * 1000).toISOString(),
    review_by_iso: new Date(Number(reviewBy) * 1000).toISOString(),
    refund_policy: 'refund-to-sponsor-on-expiry',
    disclosures: [
      'Approval is at the sponsor\'s discretion. If the sponsor does not approve before review_by, anyone can return the reward to the sponsor. ClauseLock prevents hidden term changes and unfunded promises; it does not guarantee payment for submitted work.',
      'Deadlines are enforced against the Solana cluster clock at transaction execution time: actions must execute strictly before their deadline; refunds open at the deadline.',
    ],
    field_clauses: Object.fromEntries(FIELDS.map((f) => [f, chosen[f]!])) as Record<Field, string>,
    clauses: used.map((id) => { const x = q(id); return {id, source: x.source, url: x.url, quote: x.quote} }),
    resolutions: appliedResolutions,
  }
  return {ok: true, doc, digest: digestHex(doc), issues: []}
}

/** Contributor-side check before signing: the document must hash to the on-chain digest and its fields must equal the on-chain fields. */
export function checkDocAgainstChain(doc: TermsDoc, chain: {sponsor: string; contributor: string; escrowId: string; amount: string; acceptBy: string; submitBy: string; reviewBy: string; refundPolicy: number; docDigestHex: string}): string[] {
  const errs: string[] = []
  if (digestHex(doc) !== chain.docDigestHex) errs.push('terms document digest does not match the on-chain doc_digest')
  const pairs: [string, string, string][] = [
    ['sponsor', doc.parties.sponsor, chain.sponsor], ['contributor', doc.parties.contributor, chain.contributor],
    ['escrow_id', doc.escrow_id, chain.escrowId], ['amount', doc.amount_lamports, chain.amount],
    ['accept_by', doc.accept_by, chain.acceptBy], ['submit_by', doc.submit_by, chain.submitBy], ['review_by', doc.review_by, chain.reviewBy],
    ['refund_policy', doc.refund_policy === 'refund-to-sponsor-on-expiry' ? '0' : '?', String(chain.refundPolicy)],
  ]
  for (const [k, a, b] of pairs) if (a !== b) errs.push(`${k}: document says ${a}, chain says ${b}`)
  return errs
}
