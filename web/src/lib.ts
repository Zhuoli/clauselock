import {Buffer} from 'buffer'
import {Connection, Keypair, PublicKey, Transaction, type TransactionInstruction} from '@solana/web3.js'
import * as cl from '../../sdk/index.ts'
import type {TermsDoc} from '../../fineprint/adapter.ts'

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
      tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
      tx.sign(kp)
      return conn.sendRawTransaction(tx.serialize())
    },
  }
}

export type TxResult = {ok: true; sig: string} | {ok: false; error: string; logs?: string[]}

/** Simulate first (so the user sees the program's verdict before signing), then send and confirm. */
export async function run(conn: Connection, actor: Actor, ixs: TransactionInstruction[]): Promise<TxResult> {
  const tx = new Transaction().add(...ixs)
  tx.feePayer = actor.publicKey
  const {blockhash, lastValidBlockHeight} = await conn.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  try {
    const sim = await conn.simulateTransaction(tx)
    if (sim.value.err) {
      const name = cl.anchorErrorFromLogs(sim.value.logs)
      return {ok: false, error: name ?? JSON.stringify(sim.value.err), logs: sim.value.logs ?? undefined}
    }
  } catch (e: any) { return {ok: false, error: `simulation failed: ${e.message ?? e}`} }
  try {
    const sig = await actor.send(tx, conn)
    const res = await conn.confirmTransaction({signature: sig, blockhash, lastValidBlockHeight}, 'confirmed')
    if (res.value.err) return {ok: false, error: JSON.stringify(res.value.err)}
    return {ok: true, sig}
  } catch (e: any) { return {ok: false, error: e.message ?? String(e), logs: e.logs} }
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
export const loadTerms = (pda: string): TermsDoc | null => { const s = localStorage.getItem(`clauselock:terms:${pda}`); return s ? JSON.parse(s) : null }
export const shareLink = (cluster: ClusterName, pda: string, doc?: TermsDoc | null) =>
  `${location.origin}${location.pathname}#view=escrow&cluster=${cluster}&escrow=${pda}${doc ? `&terms=${b64url(JSON.stringify(doc))}` : ''}`
export function readHash(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(location.hash.slice(1)))
}
export function termsFromHash(): TermsDoc | null { const t = readHash().terms; try { return t ? JSON.parse(unb64url(t)) : null } catch { return null } }

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
