import {useEffect, useState} from 'react'
import {PublicKey, type TransactionInstruction} from '@solana/web3.js'
import * as cl from '../../sdk/index.ts'
import type {TermsDoc} from '../../fineprint/adapter.ts'
import {useApp} from './App'
import {chainNow, explorerTx, fetchEscrow, loadTerms, run, shareLink, short, sol, termsFromHash, type TxResult} from './lib'
import {Citation, Time} from './TermsCard'

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

export function EscrowView({escrow, setEscrow}: {escrow: string; setEscrow: (s: string) => void}) {
  const {cluster, conn, actor} = useApp()
  const [input, setInput] = useState(escrow)
  const [data, setData] = useState<{escrow: cl.Escrow; lamports: number} | null>(null)
  const [doc, setDoc] = useState<TermsDoc | null>(null)
  const [now, setNow] = useState(0n)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<TxResult | null>(null)

  const load = async (pda = input) => {
    if (!pda) return
    try {
      const r = await fetchEscrow(conn, new PublicKey(pda))
      if (!r) { setErr('No escrow at that address on this cluster.'); setData(null); return }
      setErr(''); setData(r); setEscrow(pda); setNow(await chainNow(conn)); setDoc(termsFromHash() ?? loadTerms(pda))
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(escrow); const t = setInterval(() => load(), 5000); return () => clearInterval(t) }, [escrow, conn])

  const e = data?.escrow
  const pda = e ? new PublicKey(input) : null
  const cm = doc?.field_clauses ?? {}
  const act = async (ixs: TransactionInstruction[]) => { if (!actor) return; setResult(null); const r = await run(conn, actor, ixs); setResult(r); await load() }
  const isSponsor = !!(actor && e && actor.publicKey.equals(e.sponsor))
  const quote = (id: string) => doc?.clauses.find((c) => c.id === id)

  return (
    <section>
      <h2>Escrow status</h2>
      <div className="row">
        <input data-testid="status-escrow-input" value={input} onChange={(x) => setInput(x.target.value.trim())} placeholder="escrow address" style={{flex: 1}} />
        <button data-testid="status-load" onClick={() => load()}>Load</button>
      </div>
      {err && <p className="bad">{err}</p>}
      {e && pda && <div className="grid">
        <div className="card">
          <h3>State: <span data-testid="status-state">{e.state}</span></h3>
          <p>Sponsor <code>{short(e.sponsor)}</code> · contributor <code>{short(e.contributor)}</code> · reward {sol(e.amount)} · account balance {sol(data!.lamports)} (reward + rent receipt)</p>
          <p className="mono">terms_hash {e.termsHash.toString('hex')}<br />doc_digest {Buffer.from(e.docDigest).toString('hex')}</p>
          <ol className="timeline" data-testid="timeline">
            {timeline(e).map((s) => (
              <li key={s.key} className={s.done ? 'done' : now >= (s.deadline ?? 0n) && s.deadline ? 'missed' : 'pending'}>
                <b>{s.label}</b> {s.note && <small>{s.note}</small>}
                {s.at ? <div>at <Time t={s.at} /></div> : null}
                {s.deadline && <div>deadline <Time t={s.deadline} /> {doc && s.field && <Citation doc={doc} field={s.field} />}
                  {s.field && quote((cm as any)[s.field]) && <div className="quote">“{quote((cm as any)[s.field])!.quote}”</div>}</div>}
              </li>
            ))}
          </ol>
          <p>Cluster time: <Time t={now} /></p>
        </div>
        <div className="card">
          <h3>What can happen now</h3>
          <table className="can" data-testid="can-table"><tbody>
            {(['accept', 'submit', 'approve', 'pay', 'refund', 'cancel'] as const).map((a) => {
              const v = cl.explain(e, now, a, cm)
              return <tr key={a} className={v.allowed ? 'good' : ''}><th>can_{a}</th><td>{v.allowed ? 'yes' : 'no'}</td><td>{v.reason}{v.clauses.length > 0 && <> <small>[{v.clauses.join(', ')}]</small></>}</td></tr>
            })}
          </tbody></table>
          <div className="actions">
            {e.state === 'Submitted' && <button data-testid="approve" disabled={!isSponsor} onClick={() => act([cl.approveIx(actor!.publicKey, pda)])}>Approve (sponsor)</button>}
            {e.state === 'Funded' && <button data-testid="cancel" disabled={!isSponsor} onClick={() => act([cl.cancelIx(actor!.publicKey, pda)])}>Cancel offer (sponsor)</button>}
            {e.state === 'Approved' && <button data-testid="pay" disabled={!actor} onClick={() => act([cl.finalizePaymentIx(actor!.publicKey, pda, e.contributor)])}>Finalize payment (anyone)</button>}
            {['Funded', 'Accepted', 'Submitted'].includes(e.state) && <button data-testid="refund" disabled={!actor} onClick={() => act([cl.finalizeRefundIx(actor!.publicKey, pda, e.sponsor)])}>Finalize refund (anyone)</button>}
            {(e.state === 'Paid' || e.state === 'Refunded') && <button className="small" data-testid="sweep" disabled={!actor} onClick={() => act([cl.sweepExcessIx(actor!.publicKey, pda, e.sponsor)])}>Sweep stray SOL to sponsor</button>}
          </div>
          <p><small>Buttons simulate first; if the program would reject, you see its reason and nothing is signed.</small></p>
          {result && (result.ok ? <p className="good" data-testid="status-tx-ok">Confirmed · <a target="_blank" href={explorerTx(cluster, result.sig)}>{result.sig.slice(0, 16)}…</a></p>
            : <p className="bad" data-testid="status-tx-error">Program rejected: <b>{result.error}</b></p>)}
          <h3>Share with the contributor</h3>
          <input readOnly data-testid="share-link" value={shareLink(cluster, input, doc)} onFocus={(x) => x.target.select()} />
          {doc && <a download={`clauselock-terms-${input}.json`} href={`data:application/json,${encodeURIComponent(JSON.stringify(doc, null, 2))}`}>Download terms JSON</a>}
        </div>
      </div>}
    </section>
  )
}
