import {useEffect, useState} from 'react'
import {PublicKey} from '@solana/web3.js'
import * as cl from '../../sdk/index.ts'
import {checkDocAgainstChain, type TermsDoc} from '../../fineprint/adapter.ts'
import {useApp} from './App'
import {chainNow, explorerTx, fetchEscrow, loadTerms, run, saveTerms, termsFromHash, type TxResult} from './lib'
import {TermsCard} from './TermsCard'

export function ContributorView({escrow, setEscrow}: {escrow: string; setEscrow: (s: string) => void}) {
  const {cluster, conn, actor, setView} = useApp()
  const [input, setInput] = useState(escrow)
  const [doc, setDoc] = useState<TermsDoc | null>(null)
  const [state, setState] = useState<cl.Escrow | null>(null)
  const [err, setErr] = useState('')
  const [ack, setAck] = useState(false)
  const [evidence, setEvidence] = useState('')
  const [result, setResult] = useState<TxResult | null>(null)
  const [now, setNow] = useState(0n)

  const load = async (pda = input) => {
    setErr(''); setState(null); setResult(null)
    try {
      const key = new PublicKey(pda)
      const r = await fetchEscrow(conn, key)
      if (!r) { setErr('No escrow at that address on this cluster.'); return }
      setState(r.escrow); setEscrow(pda); setNow(await chainNow(conn))
      setDoc(termsFromHash() ?? loadTerms(pda))
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { if (escrow) load(escrow) }, [])

  const checks = state && doc ? checkDocAgainstChain(doc, {sponsor: state.sponsor.toBase58(), contributor: state.contributor.toBase58(), escrowId: state.escrowId.toString(),
    amount: state.amount.toString(), acceptBy: state.acceptBy.toString(), submitBy: state.submitBy.toString(), reviewBy: state.reviewBy.toString(),
    refundPolicy: state.refundPolicy, docDigestHex: Buffer.from(state.docDigest).toString('hex')}) : null
  const hashOk = state ? cl.termsHash(state).equals(state.termsHash) : false
  const isContributor = !!(actor && state && actor.publicKey.equals(state.contributor))
  const verified = !!(checks && checks.length === 0 && hashOk)
  const pda = state ? new PublicKey(input) : null

  const act = async (ixs: ReturnType<typeof cl.acceptIx>[]) => {
    if (!actor) return
    setResult(null); const r = await run(conn, actor, ixs); setResult(r); if (r.ok) await load(input)
  }
  const cm = doc?.field_clauses ?? {}
  return (
    <section>
      <h2>Contributor: check the document against the chain, then sign the exact hash</h2>
      <div className="row">
        <input data-testid="escrow-input" value={input} onChange={(e) => setInput(e.target.value.trim())} placeholder="escrow address" style={{flex: 1}} />
        <button data-testid="load-escrow" onClick={() => load()}>Load</button>
      </div>
      {err && <p className="bad">{err}</p>}
      {state && <div className="grid">
        <div className="card">
          <h3>Verification</h3>
          <ul className="checks" data-testid="checks">
            <li className={hashOk ? 'good' : 'bad'}>terms_hash recomputed from on-chain fields: {hashOk ? 'matches' : 'MISMATCH'}</li>
            {!doc && <li className="bad">No terms document. Open the sponsor's share link or upload the JSON.</li>}
            {checks && checks.length === 0 && <li className="good">Terms document hashes to the on-chain doc_digest and every field matches</li>}
            {checks?.map((c) => <li key={c} className="bad">{c}</li>)}
            <li className={isContributor ? 'good' : 'warn'}>{isContributor ? 'You are the invited contributor' : `Only ${state.contributor.toBase58()} can accept`}</li>
            <li>Escrow holds the reward: state <b data-testid="state">{state.state}</b></li>
          </ul>
          <label>Upload terms JSON <input type="file" accept=".json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const d = JSON.parse(await f.text()); setDoc(d); saveTerms(input, d) } }} /></label>
          <p className="mono">terms_hash {state.termsHash.toString('hex')}</p>
          {state.state === 'Funded' && <>
            <label className="ack"><input type="checkbox" data-testid="ack" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I understand approval is at the sponsor's discretion, and if they do not approve by the review deadline the reward returns to them.</label>
            <p>{cl.explain(state, now, 'accept', cm, actor?.publicKey).reason}</p>
            <button data-testid="accept" disabled={!verified || !ack || !isContributor} onClick={() => act([cl.acceptIx(actor!.publicKey, pda!, state.termsHash)])}>
              Accept terms hash {state.termsHash.toString('hex').slice(0, 12)}…</button>
            {!verified && <p className="bad">Signing is blocked until every check passes.</p>}
          </>}
          {state.state === 'Accepted' && <>
            <label>Evidence (URL, commit, notes; only its SHA-256 goes on-chain)
              <textarea data-testid="evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} /></label>
            {evidence && <p className="mono">evidence_hash {cl.sha256(evidence).toString('hex')}</p>}
            <p>{cl.explain(state, now, 'submit', cm, actor?.publicKey).reason}</p>
            <button data-testid="submit-evidence" disabled={!evidence || !isContributor} onClick={() => { localStorage.setItem(`clauselock:evidence:${input}`, evidence); act([cl.submitEvidenceIx(actor!.publicKey, pda!, cl.sha256(evidence))]) }}>Submit evidence hash</button>
          </>}
          {state.state === 'Approved' && <button data-testid="contrib-pay" disabled={!actor} onClick={() => act([cl.finalizePaymentIx(actor!.publicKey, pda!, state.contributor)])}>Claim payment (you pay the fee)</button>}
          {result && (result.ok ? <p className="good" data-testid="tx-ok">Confirmed · <a target="_blank" href={explorerTx(cluster, result.sig)}>{result.sig.slice(0, 16)}…</a></p>
            : <p className="bad" data-testid="tx-error">Program rejected: <b>{result.error}</b></p>)}
          <button className="small" onClick={() => setView('escrow', input)}>Open status timeline →</button>
        </div>
        {doc && <TermsCard doc={doc} />}
      </div>}
    </section>
  )
}
