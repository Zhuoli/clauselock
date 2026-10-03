import {Buffer} from 'buffer'
import {Connection, Keypair, PublicKey, Transaction, type TransactionInstruction} from '@solana/web3.js'
import * as cl from '../../sdk/index.ts'
import {checkDocAgainstChain, type Packet, type TermsDoc} from '../../fineprint/adapter.ts'

export type ClusterName = 'localnet' | 'devnet'
export const CLUSTERS: Record<ClusterName, string> = {localnet: 'http://127.0.0.1:8899', devnet: 'https://api.devnet.solana.com'}
export const programIdFor = (_c: ClusterName) => cl.PROGRAM_ID

/** Anything that can pay for and sign a transaction: a browser wallet (Phantom via Wallet Standard) or a localnet burner. */
export type Actor = {label: string; publicKey: PublicKey; send: (tx: Transaction, conn: Connection) => Promise<string>}

export function burnerActor(role: string): Actor {
  const key = `clauselock:burner:${role}`
  let secret = localStorage.getItem(key)
  if (!secret) { secret = JSON.stringify(Array.from(Keypair.generate().secretKey)); localStorage.setItem(key, secret) }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)))
  return {
    label: `burner:${role}`, publicKey: kp.publicKey,
    send: async (tx, conn) => {
      tx.feePayer = kp.publicKey
      if (!tx.recentBlockhash) tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash // run() sets it; keep one blockhash/expiry pair end to end
      tx.sign(kp)
      return conn.sendRawTransaction(tx.serialize())
    },
  }
}

/** kind: program = the program (or runtime) rejected it; wallet = the wallet refused/failed to sign; rpc = network/RPC error before broadcast;
 *  pending = broadcast but confirmation is unknown (the transaction may still land: check the signature before retrying). */
export type TxResult = {ok: true; sig: string} | {ok: false; kind: 'program' | 'wallet' | 'rpc' | 'pending'; error: string; sig?: string; logs?: string[]}
export const TX_KIND_LABEL = {program: 'Program rejected', wallet: 'Wallet did not sign', rpc: 'Network/RPC error', pending: 'Sent, confirmation unknown'} as const

/** Simulate first (so the user sees the program's verdict before signing), then send and confirm with the same blockhash/expiry pair. Never throws. */
export async function run(conn: Connection, actor: Actor, ixs: TransactionInstruction[]): Promise<TxResult> {
  let blockhash: string, lastValidBlockHeight: number
  const tx = new Transaction().add(...ixs)
  try {
    ;({blockhash, lastValidBlockHeight} = await conn.getLatestBlockhash('confirmed'))
    tx.feePayer = actor.publicKey; tx.recentBlockhash = blockhash
    const sim = await conn.simulateTransaction(tx)
    if (sim.value.err) {
      const name = cl.anchorErrorFromLogs(sim.value.logs)
      return {ok: false, kind: 'program', error: name ?? JSON.stringify(sim.value.err), logs: sim.value.logs ?? undefined}
    }
  } catch (e: any) { return {ok: false, kind: 'rpc', error: `simulation failed: ${e?.message ?? e}`} }
  let sig: string
  try { sig = await actor.send(tx, conn) } catch (e: any) {
    const msg = e?.message ?? String(e)
    return {ok: false, kind: /reject|denied|cancel|user/i.test(msg) || e?.name?.startsWith?.('Wallet') ? 'wallet' : 'rpc', error: msg, logs: e?.logs}
  }
  try {
    const res = await conn.confirmTransaction({signature: sig, blockhash, lastValidBlockHeight}, 'confirmed')
    if (res.value.err) return {ok: false, kind: 'program', error: JSON.stringify(res.value.err), sig}
    return {ok: true, sig}
  } catch (e: any) {
    return {ok: false, kind: 'pending', error: `${e?.message ?? e}. Check the signature in Explorer and reload before retrying.`, sig}
  }
}

/** Cluster time from the latest block; falls back to this computer's clock and says so. */
export async function chainTime(conn: Connection): Promise<{t: bigint; fromChain: boolean}> {
  try { const t = await conn.getBlockTime(await conn.getSlot('confirmed')); if (t) return {t: BigInt(t), fromChain: true} } catch {}
  return {t: BigInt(Math.floor(Date.now() / 1000)), fromChain: false}
}

export async function chainNow(conn: Connection): Promise<bigint> {
  try { const t = await conn.getBlockTime(await conn.getSlot('confirmed')); if (t) return BigInt(t) } catch {}
  return BigInt(Math.floor(Date.now() / 1000))
}

export async function fetchEscrow(conn: Connection, pda: PublicKey): Promise<{escrow: cl.Escrow; lamports: number} | null> {
  const info = await conn.getAccountInfo(pda, 'confirmed')
  if (!info) return null
  return {escrow: cl.decodeVerifiedEscrow(pda, info), lamports: info.lamports}
}

// ---------- terms doc transport: localStorage + URL fragment ----------
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
export const saveTerms = (pda: string, doc: TermsDoc) => localStorage.setItem(`clauselock:terms:${pda}`, JSON.stringify(doc))
export const loadTerms = (pda: string): TermsDoc | null => { try { const s = localStorage.getItem(`clauselock:terms:${pda}`); return s ? asTermsDoc(JSON.parse(s)) : null } catch { return null } }
/** Only pass a doc that verified against the chain. */
export const shareLink = (cluster: ClusterName, pda: string, doc?: TermsDoc | null) =>
  `${location.origin}${location.pathname}#view=escrow&cluster=${cluster}&escrow=${pda}${doc ? `&terms=${b64url(JSON.stringify(doc))}` : ''}`
export function readHash(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(location.hash.slice(1)))
}
export function termsFromHash(): TermsDoc | null { const t = readHash().terms; try { return t ? asTermsDoc(JSON.parse(unb64url(t))) : null } catch { return null } }

/** Minimal shape check so malformed JSON (from a link, upload or storage) is rejected instead of crashing the render. */
export function asTermsDoc(d: any): TermsDoc | null {
  const ok = d && typeof d === 'object' && d.bounty && typeof d.bounty.title === 'string' && d.parties && typeof d.parties.contributor === 'string'
    && Array.isArray(d.clauses) && Array.isArray(d.resolutions) && Array.isArray(d.disclosures) && d.field_clauses && typeof d.field_clauses === 'object'
    && ['amount_lamports', 'accept_by', 'submit_by', 'review_by'].every((k) => /^\d+$/.test(String(d[k])))
  return ok ? d as TermsDoc : null
}
export function asPacket(p: any): Packet | null {
  return p && typeof p === 'object' && p.bounty && typeof p.bounty.title === 'string' && Array.isArray(p.ruleSources) && Array.isArray(p.clauses) && Array.isArray(p.conflicts) ? p as Packet : null
}

/** Check a terms document against an on-chain escrow: doc digest + every field, and the terms hash recomputed from on-chain fields. */
export function verifyDoc(doc: TermsDoc | null, e: cl.Escrow): {hashOk: boolean; issues: string[] | null; verified: boolean} {
  const hashOk = cl.termsHash(e).equals(e.termsHash)
  if (!doc) return {hashOk, issues: null, verified: false}
  let issues: string[]
  try {
    issues = checkDocAgainstChain(doc, {sponsor: e.sponsor.toBase58(), contributor: e.contributor.toBase58(), escrowId: e.escrowId.toString(),
      amount: e.amount.toString(), acceptBy: e.acceptBy.toString(), submitBy: e.submitBy.toString(), reviewBy: e.reviewBy.toString(),
      refundPolicy: e.refundPolicy, docDigestHex: Buffer.from(e.docDigest).toString('hex')})
  } catch (x: any) { issues = [`terms document could not be checked: ${x?.message ?? x}`] }
  return {hashOk, issues, verified: hashOk && issues.length === 0}
}
export const isPubkey = (s: string) => { try { new PublicKey(s); return true } catch { return false } }
export const asCluster = (c: unknown): ClusterName | null => (c === 'localnet' || c === 'devnet' ? c : null)

// ---------- time ----------
export const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone
export function fmtLocal(t: bigint | number) {
  const d = new Date(Number(t) * 1000)
  return d.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'medium'})
}
export const fmtUtc = (t: bigint | number) => new Date(Number(t) * 1000).toISOString().replace('.000Z', 'Z').replace('T', ' ')
export const short = (k: PublicKey | string) => { const s = typeof k === 'string' ? k : k.toBase58(); return `${s.slice(0, 4)}…${s.slice(-4)}` }
export const explorerTx = (cluster: ClusterName, sig: string) =>
  cluster === 'devnet' ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(CLUSTERS.localnet)}`
export const sol = (lamports: bigint | number) => `${(Number(lamports) / 1e9).toLocaleString(undefined, {maximumFractionDigits: 9})} SOL`
