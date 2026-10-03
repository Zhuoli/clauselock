import {useEffect, useRef, useState} from 'react'
import {PublicKey, type TransactionInstruction} from '@solana/web3.js'
import * as cl from '../../sdk/index.ts'
import type {TermsDoc} from '../../fineprint/adapter.ts'
import {useApp} from './App'
import {asTermsDoc, chainTime, fetchEscrow, isPubkey, loadTerms, run, saveTerms, termsFromHash, verifyDoc, type TxResult} from './lib'
import {TermsCard, TxFeedback} from './TermsCard'

/** What was actually loaded: every instruction is built from this snapshot, never from the draft input box. */
type Snap = {pda: PublicKey; escrow: cl.Escrow; now: bigint; fromChain: boolean}

export function ContributorView({escrow, setEscrow}: {escrow: string; setEscrow: (s: string) => void}) {
  const {cluster, conn, actor, setView, refreshBalance} = useApp()
  const [input, setInput] = useState(escrow)
  const [doc, setDoc] = useState<TermsDoc | null>(null)
  const [snap, setSnap] = useState<Snap | null>(null)
  const [err, setErr] = useState('')
  const [ack, setAck] = useState(false)
  const [evidence, setEvidence] = useState('')
  const [result, setResult] = useState<TxResult | null>(null)
  const [busy, setBusy] = useState(false)
  const req = useRef(0)
  const loadedPda = useRef('')

  /** keep=false: user pressed Load (clear feedback); keep=true: background/after-tx refresh. */
  const load = async (addr: string, keep = false) => {
    const id = ++req.current
    if (!keep) { setErr(''); setResult(null) }
    if (!isPubkey(addr)) { setErr('Not a valid escrow address.'); setSnap(null); loadedPda.current = ''; return }
    try {
      const pda = new PublicKey(addr)
      const r = await fetchEscrow(conn, pda); const {t, fromChain} = await chainTime(conn)
      if (id !== req.current) return // a newer request superseded this one
      if (!r) { setErr('No escrow at that address on this cluster.'); setSnap(null); return }
      if (loadedPda.current !== addr) { loadedPda.current = addr; setAck(false); setDoc(termsFromHash() ?? loadTerms(addr)) }
      setSnap({pda, escrow: r.escrow, now: t, fromChain})
      setEscrow(addr)
    } catch (e: any) { if (id === req.current) { setErr(e?.message ?? String(e)); setSnap(null) } }
  }
  useEffect(() => { if (escrow) load(escrow) }, [])
  // Refresh state and cluster time while open, so an expired or settled offer never looks open.
  useEffect(() => { const t = setInterval(() => snap && !busy && load(snap.pda.toBase58(), true), 5000); return () => clearInterval(t) }, [snap?.pda.toBase58(), busy, conn])

  const state = snap?.escrow ?? null
  const {hashOk, issues, verified} = state ? verifyDoc(doc, state) : {hashOk: false, issues: null, verified: false}
  const isContributor = !!(actor && state && actor.publicKey.equals(state.contributor))
  const draftDiffers = !!snap && input !== snap.pda.toBase58()

  const act = async (ixs: TransactionInstruction[]) => {
    if (!actor || !snap || busy) return
    setBusy(true); setResult(null)
    try { const r = await run(conn, actor, ixs); setResult(r); if (r.ok || r.kind === 'pending') await load(snap.pda.toBase58(), true); refreshBalance() }
    finally { setBusy(false) }
  }
  const onUpload = async (f: File) => {
    try { const d = asTermsDoc(JSON.parse(await f.text())); if (!d) { setErr('That file is not a ClauseLock terms document.'); return } setDoc(d); setAck(false); if (snap) saveTerms(snap.pda.toBase58(), d) }
    catch (e: any) { setErr(`Could not read terms JSON: ${e?.message ?? e}`) }
  }
  const cm = doc?.field_clauses ?? {}
  const canSign = !busy && !draftDiffers
  return (
    <section>
      <h2>Contributor: check the document against the chain, then sign the exact hash</h2>
      <div className="row">
        <label style={{flex: 1}}>Escrow address
          <input data-testid="escrow-input" value={input} onChange={(e) => setInput(e.target.value.trim())} placeholder="base58 escrow account" /></label>
        <button data-testid="load-escrow" onClick={() => load(input)}>Load</button>
      </div>
      {err && <p className="bad" role="alert">{err}</p>}
      {draftDiffers && <p className="warn" role="status">The address above differs from the loaded escrow {snap!.pda.toBase58()}. Press Load before signing anything.</p>}
      {state && snap && <div className="grid">
        <div className="card">
          <h3>Verification</h3>
          <ul className="checks" data-testid="checks">
            <li className={hashOk ? 'good' : 'bad'}>terms_hash recomputed from on-chain fields: {hashOk ? 'matches' : 'MISMATCH'}</li>
            {!doc && <li className="bad">No terms document. Open the sponsor's share link or upload the JSON.</li>}
            {issues && issues.length === 0 && <li className="good">Terms document hashes to the on-chain doc_digest and every field matches</li>}
            {issues?.map((c) => <li key={c} className="bad">{c}</li>)}
            <li className={isContributor ? 'good' : 'warn'}>{isContributor ? 'You are the invited contributor' : `Only ${state.contributor.toBase58()} can accept`}</li>
            <li>Escrow state <b data-testid="state">{state.state}</b> · {cluster} · {snap.fromChain ? 'cluster time' : 'this computer\'s clock (cluster time unavailable)'}</li>
          </ul>
          <label>Upload terms JSON <input type="file" accept=".json" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} /></label>
          <p className="mono">terms_hash {state.termsHash.toString('hex')}</p>
          {state.state === 'Funded' && <>
            <label className="ack"><input type="checkbox" data-testid="ack" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I understand approval is at the sponsor's discretion, and if they do not approve by the review deadline the reward returns to them.</label>
            <p>{cl.explain(state, snap.now, 'accept', cm, actor?.publicKey).reason}</p>
            <button data-testid="accept" disabled={!verified || !ack || !isContributor || !canSign} onClick={() => act([cl.acceptIx(actor!.publicKey, snap.pda, state.termsHash)])}>
              {busy ? 'Waiting for signature…' : `Accept terms hash ${state.termsHash.toString('hex').slice(0, 12)}…`}</button>
            {!verified && <p className="bad">Signing is blocked until every check passes.</p>}
          </>}
          {state.state === 'Accepted' && <>
            <label>Evidence (URL, commit, notes; only its SHA-256 goes on-chain; send the text itself to the sponsor)
              <textarea data-testid="evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} /></label>
            {evidence && <p className="mono">evidence_hash {cl.sha256(evidence).toString('hex')}</p>}
            <p>{cl.explain(state, snap.now, 'submit', cm, actor?.publicKey).reason}</p>
            <button data-testid="submit-evidence" disabled={!evidence || !isContributor || !canSign} onClick={() => { localStorage.setItem(`clauselock:evidence:${snap.pda.toBase58()}`, evidence); act([cl.submitEvidenceIx(actor!.publicKey, snap.pda, cl.sha256(evidence))]) }}>
              {busy ? 'Waiting for signature…' : 'Submit evidence hash'}</button>
          </>}
          {state.state === 'Approved' && <button data-testid="contrib-pay" disabled={!actor || !canSign} onClick={() => act([cl.finalizePaymentIx(actor!.publicKey, snap.pda, state.contributor)])}>Claim payment (you pay the fee)</button>}
          <TxFeedback result={result} cluster={cluster} p="tx" />
          <button className="small" onClick={() => setView('escrow', snap.pda.toBase58())}>Open status timeline →</button>
        </div>
        {doc && <TermsCard doc={doc} />}
      </div>}
    </section>
  )
}
