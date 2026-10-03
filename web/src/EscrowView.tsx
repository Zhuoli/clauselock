import {useEffect, useRef, useState} from 'react'
import {PublicKey, type TransactionInstruction} from '@solana/web3.js'
import * as cl from '../../sdk/index.ts'
import type {TermsDoc} from '../../fineprint/adapter.ts'
import {useApp} from './App'
import {chainTime, fetchEscrow, isPubkey, loadTerms, run, shareLink, short, sol, termsFromHash, verifyDoc, type TxResult} from './lib'
import {Citation, Time, TxFeedback} from './TermsCard'

type Step = {key: string; label: string; at?: bigint; deadline?: bigint; field?: string; done: boolean; note?: string}

export function timeline(e: cl.Escrow): Step[] {
  const settled = e.state === 'Paid' || e.state === 'Refunded'
  const order = ['Funded', 'Accepted', 'Submitted', 'Approved', 'Paid']
  const reached = (s: string) => e.state === 'Refunded' ? ({Funded: true, Accepted: e.acceptedAt > 0n, Submitted: e.submittedAt > 0n, Approved: false} as any)[s] ?? false
    : order.indexOf(e.state) >= order.indexOf(s)
  const steps: Step[] = [
    {key: 'Funded', label: `Funded with ${sol(e.amount)}`, at: e.createdAt, done: true},
    {key: 'Accepted', label: 'Contributor accepted the terms hash', at: e.acceptedAt || undefined, deadline: e.acceptBy, field: 'accept_by', done: reached('Accepted')},
    {key: 'Submitted', label: 'Evidence hash submitted', at: e.submittedAt || undefined, deadline: e.submitBy, field: 'submit_by', done: reached('Submitted'),
      note: e.evidenceHash.some((b) => b) ? `evidence ${e.evidenceHash.toString('hex').slice(0, 16)}…` : undefined},
    {key: 'Approved', label: 'Sponsor approved (irrevocable)', at: e.approvedAt || undefined, deadline: e.reviewBy, field: 'review_by', done: reached('Approved')},
  ]
  if (e.state === 'Refunded') steps.push({key: 'Refunded', label: `Refunded to sponsor, triggered by ${short(e.settledBy)}`, at: e.settledAt, field: 'refund_policy', done: true})
  else steps.push({key: 'Paid', label: settled ? `Paid to contributor, triggered by ${short(e.settledBy)}` : 'Paid to contributor (anyone can trigger after approval)', at: settled ? e.settledAt : undefined, done: settled})
  return steps
}

type Snap = {pda: PublicKey; escrow: cl.Escrow; lamports: number; now: bigint; fromChain: boolean}

export function EscrowView({escrow, setEscrow}: {escrow: string; setEscrow: (s: string) => void}) {
  const {cluster, conn, actor, refreshBalance} = useApp()
  const [input, setInput] = useState(escrow)
  const [snap, setSnap] = useState<Snap | null>(null)
  const [doc, setDoc] = useState<TermsDoc | null>(null)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<TxResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [evidenceText, setEvidenceText] = useState('')
  const req = useRef(0)

  const load = async (addr: string) => {
    if (!addr) return
    const id = ++req.current
    if (!isPubkey(addr)) { setErr('Not a valid escrow address.'); setSnap(null); return }
    try {
      const pda = new PublicKey(addr)
      const r = await fetchEscrow(conn, pda); const {t, fromChain} = await chainTime(conn)
      if (id !== req.current) return // superseded by a newer load
      if (!r) { setErr('No escrow at that address on this cluster.'); setSnap(null); return }
      setErr(''); setSnap({pda, escrow: r.escrow, lamports: r.lamports, now: t, fromChain}); setEscrow(addr); setDoc(termsFromHash() ?? loadTerms(addr))
      setEvidenceText((v) => v || localStorage.getItem(`clauselock:evidence:${addr}`) || '')
    } catch (e: any) { if (id === req.current) { setErr(e?.message ?? String(e)); setSnap(null) } }
  }
  const loaded = snap?.pda.toBase58() ?? ''
  const busyRef = useRef(false); busyRef.current = busy
  const loadedRef = useRef(''); loadedRef.current = loaded
  useEffect(() => { load(escrow); const t = setInterval(() => !busyRef.current && load(loadedRef.current || escrow), 5000); return () => clearInterval(t) }, [escrow, conn])

  const e = snap?.escrow
  const v = e ? verifyDoc(doc, e) : null
  // Only a document that verifies against this account is used for citations, quotes and sharing.
  const vdoc = v?.verified ? doc : null
  const cm = vdoc?.field_clauses ?? {}
  const draftDiffers = !!snap && input !== loaded
  const act = async (ixs: TransactionInstruction[]) => {
    if (!actor || !snap || busy) return
    setBusy(true); setResult(null)
    try { const r = await run(conn, actor, ixs); setResult(r); await load(loaded); refreshBalance() } finally { setBusy(false) }
  }
  const isSponsor = !!(actor && e && actor.publicKey.equals(e.sponsor))
  const quote = (id: string) => vdoc?.clauses.find((c) => c.id === id)
  const evidenceSet = !!e && e.evidenceHash.some((b) => b)
  const evidenceOk = evidenceSet && !!evidenceText && cl.sha256(evidenceText).equals(e!.evidenceHash)
  const can = !busy && !draftDiffers
  const docBad = !!doc && !v?.verified

  return (
    <section>
      <h2>Escrow status</h2>
      <div className="row">
        <label style={{flex: 1}}>Escrow address
          <input data-testid="status-escrow-input" value={input} onChange={(x) => setInput(x.target.value.trim())} placeholder="base58 escrow account" /></label>
        <button data-testid="status-load" onClick={() => { setResult(null); load(input) }}>Load</button>
      </div>
      {err && <p className="bad" role="alert">{err}</p>}
      {draftDiffers && <p className="warn" role="status">The address above differs from the loaded escrow {loaded}. Press Load before acting.</p>}
      {e && snap && <div className="grid">
        <div className="card">
          <h3>State: <span data-testid="status-state">{e.state}</span></h3>
          <p>Sponsor <code>{short(e.sponsor)}</code> · contributor <code>{short(e.contributor)}</code> · reward {sol(e.amount)} · account balance {sol(snap.lamports)} (reward + rent receipt)</p>
          {docBad && <p className="bad" role="alert">The terms document you have does not match this escrow ({v!.issues?.[0] ?? 'terms hash mismatch'}). Its quotes are hidden; do not rely on it.</p>}
          {!doc && <p className="warn">No terms document for this escrow in this browser: deadlines below come from the chain, without clause quotes.</p>}
          <p className="mono">terms_hash {e.termsHash.toString('hex')}<br />doc_digest {Buffer.from(e.docDigest).toString('hex')}</p>
          <ol className="timeline" data-testid="timeline">
            {timeline(e).map((s) => (
              <li key={s.key} className={s.done ? 'done' : snap.now >= (s.deadline ?? 0n) && s.deadline ? 'missed' : 'pending'}>
                <b>{s.label}</b> {s.note && <small>{s.note}</small>}
                {s.at ? <div>at <Time t={s.at} /></div> : null}
                {s.deadline && <div>deadline <Time t={s.deadline} /> {vdoc && s.field && <Citation doc={vdoc} field={s.field} />}
                  {s.field && quote((cm as any)[s.field]) && <div className="quote">“{quote((cm as any)[s.field])!.quote}”</div>}</div>}
              </li>
            ))}
          </ol>
          <p>{snap.fromChain ? 'Cluster time' : 'This computer\'s clock (cluster time unavailable)'}: <Time t={snap.now} /></p>
        </div>
        <div className="card">
          <h3>What can happen now</h3>
          <table className="can" data-testid="can-table"><tbody>
            {(['accept', 'submit', 'approve', 'pay', 'refund', 'cancel'] as const).map((a) => {
              const x = cl.explain(e, snap.now, a, cm)
              return <tr key={a} className={x.allowed ? 'good' : ''}><th>can_{a}</th><td>{x.allowed ? 'yes' : 'no'}</td><td>{x.reason}{x.clauses.length > 0 && <> <small>[{x.clauses.join(', ')}]</small></>}</td></tr>
            })}
          </tbody></table>
          {evidenceSet && <div className="card">
            <label>Evidence the contributor sent you (checked against the on-chain hash)
              <textarea data-testid="evidence-check" value={evidenceText} onChange={(x) => setEvidenceText(x.target.value)} /></label>
            <p className="mono">on-chain evidence_hash {e.evidenceHash.toString('hex')}</p>
            {evidenceText && <p className={evidenceOk ? 'good' : 'bad'} data-testid="evidence-match" role="status">{evidenceOk ? 'Matches the on-chain evidence hash' : 'Does NOT match the on-chain evidence hash'}</p>}
          </div>}
          <div className="actions">
            {e.state === 'Submitted' && <>
              <p className="warn">Approval is irrevocable: after it, the reward can only go to the contributor.</p>
              <button data-testid="approve" disabled={!isSponsor || !can || docBad} onClick={() => act([cl.approveIx(actor!.publicKey, snap.pda)])}>{busy ? 'Waiting…' : 'Approve (sponsor)'}</button></>}
            {e.state === 'Funded' && <button data-testid="cancel" disabled={!isSponsor || !can} onClick={() => act([cl.cancelIx(actor!.publicKey, snap.pda)])}>Cancel offer (sponsor)</button>}
            {e.state === 'Approved' && <button data-testid="pay" disabled={!actor || !can} onClick={() => act([cl.finalizePaymentIx(actor!.publicKey, snap.pda, e.contributor)])}>{busy ? 'Waiting…' : 'Finalize payment (anyone)'}</button>}
            {['Funded', 'Accepted', 'Submitted'].includes(e.state) && <button data-testid="refund" disabled={!actor || !can} onClick={() => act([cl.finalizeRefundIx(actor!.publicKey, snap.pda, e.sponsor)])}>Finalize refund (anyone)</button>}
            {(e.state === 'Paid' || e.state === 'Refunded') && <button className="small" data-testid="sweep" disabled={!actor || !can} onClick={() => act([cl.sweepExcessIx(actor!.publicKey, snap.pda, e.sponsor)])}>Sweep stray SOL to sponsor</button>}
          </div>
          <p><small>Buttons simulate first; if the program would reject, you see its reason and nothing is signed.</small></p>
          <TxFeedback result={result} cluster={cluster} p="status-tx" />
          <h3>Share with the contributor</h3>
          <label>Share link {vdoc ? '(carries the verified terms document)' : '(no verified terms document to attach)'}
            <input readOnly data-testid="share-link" value={shareLink(cluster, loaded, vdoc)} onFocus={(x) => x.target.select()} /></label>
          {vdoc && <a download={`clauselock-terms-${loaded}.json`} href={`data:application/json,${encodeURIComponent(JSON.stringify(vdoc, null, 2))}`}>Download terms JSON</a>}
        </div>
      </div>}
    </section>
  )
}
