import {useState} from 'react'
import type {TermsDoc} from '../../fineprint/adapter.ts'
import {explorerTx, fmtLocal, fmtUtc, short, sol, tzName, TX_KIND_LABEL, type ClusterName, type TxResult} from './lib'

const FIELD_LABEL: Record<string, string> = {amount: 'Reward', contributor: 'Contributor', accept_by: 'Accept by', submit_by: 'Submit by', review_by: 'Sponsor decides by', refund_policy: 'If not approved', discretion: 'Approval'}

export function Citation({doc, field}: {doc: TermsDoc; field: string}) {
  const id = (doc.field_clauses as any)[field]
  const c = doc.clauses.find((x) => x.id === id)
  const [open, setOpen] = useState(false)
  if (!c) return null
  // A real button: keyboard-focusable, and the quote is revealed inline (not only in a hover tooltip).
  return <>
    <button type="button" className="cite" aria-expanded={open} title={`${c.source}: "${c.quote}"`} onClick={() => setOpen(!open)}>[{id}]</button>
    {open && <span className="quote" role="note"> {c.source}: “{c.quote}”</span>}
  </>
}

/** Transaction feedback with live-region semantics. testid prefix keeps the e2e selectors: `${p}-ok` / `${p}-error`. */
export function TxFeedback({result, cluster, p, okLabel = 'Confirmed'}: {result: TxResult | null; cluster: ClusterName; p: string; okLabel?: string}) {
  if (!result) return null
  if (result.ok) return <p className="good" role="status" data-testid={`${p}-ok`}>{okLabel} · <a href={explorerTx(cluster, result.sig)} target="_blank" rel="noreferrer">{result.sig.slice(0, 16)}… (Explorer)</a></p>
  return <p className={result.kind === 'pending' ? 'warn' : 'bad'} role="alert" data-testid={`${p}-error`}>{TX_KIND_LABEL[result.kind]}: <b>{result.error}</b>
    {result.sig && <> · <a href={explorerTx(cluster, result.sig)} target="_blank" rel="noreferrer">{result.sig.slice(0, 16)}…</a></>}</p>
}

export function Time({t}: {t: string | bigint | number}) {
  return <span className="time"><b>{fmtLocal(BigInt(t))}</b> <small>{tzName}</small><br /><small>{fmtUtc(BigInt(t))}</small></span>
}

export function TermsCard({doc, digest}: {doc: TermsDoc; digest?: string}) {
  const rows: [string, React.ReactNode][] = [
    ['amount', sol(BigInt(doc.amount_lamports))],
    ['contributor', <code title={doc.parties.contributor}>{short(doc.parties.contributor)}</code>],
    ['accept_by', <Time t={doc.accept_by} />], ['submit_by', <Time t={doc.submit_by} />], ['review_by', <Time t={doc.review_by} />],
    ['refund_policy', 'Reward returns to the sponsor; anyone can trigger it after the deadline'],
    ['discretion', "Sponsor's discretion (irrevocable once given)"],
  ]
  return (
    <div className="card terms" data-testid="terms-card">
      <h3>{doc.bounty.title}</h3>
      <table><tbody>
        {rows.map(([f, v]) => <tr key={f}><th>{FIELD_LABEL[f]}</th><td>{v}</td><td><Citation doc={doc} field={f} /></td></tr>)}
      </tbody></table>
      <details><summary>Clauses ({doc.clauses.length}) and resolutions ({doc.resolutions.length})</summary>
        <ul className="clauses">{doc.clauses.map((c) => <li key={c.id}><code>{c.id}</code> · {c.source}: “{c.quote}”</li>)}</ul>
        {doc.resolutions.map((r) => <p key={r.conflict}>Resolved <code>{r.conflict}</code> → <code>{r.winningClaim}</code> by {r.resolvedBy}{r.note ? `: ${r.note}` : ''}</p>)}
      </details>
      <ul className="disclosures">{doc.disclosures.map((d, i) => <li key={i}>{d}</li>)}</ul>
      {digest && <p className="mono">doc_digest {digest}</p>}
    </div>
  )
}
