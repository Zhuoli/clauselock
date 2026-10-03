import type {TermsDoc} from '../../fineprint/adapter.ts'
import {fmtLocal, fmtUtc, short, sol, tzName} from './lib'

const FIELD_LABEL: Record<string, string> = {amount: 'Reward', contributor: 'Contributor', accept_by: 'Accept by', submit_by: 'Submit by', review_by: 'Sponsor decides by', refund_policy: 'If not approved', discretion: 'Approval'}

export function Citation({doc, field}: {doc: TermsDoc; field: string}) {
  const id = (doc.field_clauses as any)[field]
  const c = doc.clauses.find((x) => x.id === id)
  if (!c) return null
  return <span className="cite" title={`${c.source}: "${c.quote}"`}>[{id}]</span>
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
