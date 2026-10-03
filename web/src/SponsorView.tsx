import {useEffect, useMemo, useState} from 'react'
import {PublicKey} from '@solana/web3.js'
import * as cl from '../../sdk/index.ts'
import {compileTerms, withDemoDeadlines, type Packet} from '../../fineprint/adapter.ts'
import demoPacket from '../../fineprint/demo-bounty.packet.json'
import {useApp} from './App'
import {asPacket, burnerActor, chainTime, run, saveTerms, shareLink, sol, type TxResult} from './lib'
import {TermsCard, TxFeedback} from './TermsCard'

const isPk = (s: string) => { try { new PublicKey(s); return true } catch { return false } }

export function SponsorView({onCreated}: {onCreated: (pda: string) => void}) {
  const {cluster, conn, actor, refreshBalance} = useApp()
  const [packet, setPacket] = useState<Packet>(demoPacket as unknown as Packet)
  const [contributor, setContributor] = useState('')
  const [escrowId, setEscrowId] = useState(() => String(Date.now()))
  const [mode, setMode] = useState<'packet' | 'demo'>('demo')
  const [minutes, setMinutes] = useState({accept_by: 2, submit_by: 4, review_by: 6})
  const [reward, setReward] = useState(cluster === 'devnet' ? '0.05' : '1')
  const [resolutions, setResolutions] = useState<Record<string, string>>({})
  const [now, setNow] = useState<number>(Math.floor(Date.now() / 1000))
  const [result, setResult] = useState<TxResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [packetErr, setPacketErr] = useState('')
  const [clock, setClock] = useState(Math.floor(Date.now() / 1000))
  const [rent, setRent] = useState<number | null>(null)
  useEffect(() => { const t = setInterval(() => setClock(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t) }, [])
  useEffect(() => { conn.getMinimumBalanceForRentExemption(cl.ESCROW_ACCOUNT_SIZE).then(setRent).catch(() => setRent(null)) }, [conn])

  const [skew, setSkew] = useState(0) // cluster time minus this computer's clock
  const refreshNow = () => chainTime(conn).then(({t}) => { setNow(Number(t)); setSkew(Number(t) - Math.floor(Date.now() / 1000)) })
  useEffect(() => { refreshNow() }, [conn, mode, minutes])
  const minutesOk = (['accept_by', 'submit_by', 'review_by'] as const).every((k) => Number.isFinite(minutes[k]) && minutes[k] > 0 && minutes[k] <= 60 * 24 * 30)
    && minutes.accept_by < minutes.submit_by && minutes.submit_by < minutes.review_by
  const rewardOk = /^\d+(\.\d{1,9})?$/.test(reward) && Number(reward) >= 0.001

  const effective = useMemo(() => mode === 'demo' && minutesOk && rewardOk
    ? withDemoDeadlines(packet, now, {accept_by: minutes.accept_by * 60, submit_by: minutes.submit_by * 60, review_by: minutes.review_by * 60}, String(Math.round(Number(reward) * 1e9)))
    : mode === 'demo' ? null : packet, [packet, mode, now, minutes, reward, minutesOk, rewardOk])

  const sponsor = actor?.publicKey.toBase58() ?? ''
  const compiled = useMemo(() => {
    if (!sponsor || !isPk(contributor) || !effective) return null
    try {
      return compileTerms({packet: effective, sponsor, contributor, escrowId,
        resolutions: Object.entries(resolutions).filter(([, w]) => w).map(([conflict, winningClaim]) => ({conflict, winningClaim, resolvedBy: 'sponsor' as const}))})
    } catch (e: any) { return {ok: false as const, issues: [{kind: 'invalid' as const, field: 'packet', message: `Packet could not be compiled: ${e?.message ?? e}`, clauses: [], quotes: []}]} }
  }, [effective, sponsor, contributor, escrowId, resolutions])

  const onFile = async (f: File) => {
    try { const p = asPacket(JSON.parse(await f.text())); if (!p) { setPacketErr('That file is not a Fine Print rule packet (needs bounty, ruleSources, clauses, conflicts).'); return } setPacket(p); setResolutions({}); setPacketErr('') }
    catch (e: any) { setPacketErr(`Not valid JSON: ${e?.message ?? e}`) }
  }
  // Deadlines are fixed when compiled. If the acceptance window has (nearly) passed, block funding and ask for an explicit refresh + re-review.
  const clusterNow = clock + skew
  const stale = !!(compiled?.ok && Number(compiled.doc.accept_by) - clusterNow < 5)

  const fund = async () => {
    if (!actor || !compiled?.ok || busy || stale) return
    setBusy(true); setResult(null)
    try {
    const d = compiled.doc
    const terms: cl.Terms = {sponsor: actor.publicKey, contributor: new PublicKey(contributor), escrowId: BigInt(escrowId), amount: BigInt(d.amount_lamports),
      acceptBy: BigInt(d.accept_by), submitBy: BigInt(d.submit_by), reviewBy: BigInt(d.review_by), refundPolicy: 0, docDigest: Buffer.from(compiled.digest, 'hex')}
    const r = await run(conn, actor, [cl.createFundIx(terms)])
    setResult(r); refreshBalance()
    if (r.ok) {
      const pda = cl.escrowPda(actor.publicKey, BigInt(escrowId)).toBase58()
      saveTerms(pda, d)
      localStorage.setItem('clauselock:last-share', shareLink(cluster, pda, d))
      setTimeout(() => onCreated(pda), 600)
    }
    } finally { setBusy(false) }
  }

  return (
    <section>
      <h2>Sponsor: Fine Print reads the rules, you resolve conflicts, the program locks the result</h2>
      <div className="grid">
        <div className="card">
          <h3>Rule packet</h3>
          <p><b>{packet.bounty.title}</b> · {packet.ruleSources.length} sources · {packet.clauses.length} clauses · {packet.conflicts.length} recorded conflicts</p>
          <label>Load another packet (Fine Print JSON) <input type="file" accept=".json" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} /></label>
          {packetErr && <p className="bad" role="alert">{packetErr}</p>}
          <h3>Parties</h3>
          <label>Sponsor (you) <input readOnly value={sponsor || 'connect a wallet'} /></label>
          <label>Invited contributor wallet
            <input data-testid="contributor-input" value={contributor} onChange={(e) => setContributor(e.target.value.trim())} placeholder="base58 address" />
          </label>
          {cluster === 'localnet' && <button className="small" data-testid="use-burner-contributor" onClick={() => setContributor(burnerActor('contributor').publicKey.toBase58())}>Use burner contributor</button>}
          <label>Escrow id (u64) <input data-testid="escrow-id" value={escrowId} onChange={(e) => setEscrowId(e.target.value.trim())} /></label>
          <h3>Deadlines</h3>
          <label><input type="radio" checked={mode === 'packet'} onChange={() => setMode('packet')} /> Use the packet's dates</label>
          <label><input type="radio" data-testid="mode-demo" checked={mode === 'demo'} onChange={() => setMode('demo')} /> Demo speed (labeled in every quote)</label>
          {mode === 'demo' && <div className="row">
            {(['accept_by', 'submit_by', 'review_by'] as const).map((k) => (
              <label key={k}>{k} +min <input data-testid={`min-${k}`} type="number" min={1} value={minutes[k]} onChange={(e) => setMinutes({...minutes, [k]: Number(e.target.value)})} /></label>
            ))}
            <label>Reward SOL <input data-testid="reward" value={reward} onChange={(e) => setReward(e.target.value.trim())} /></label>
          </div>}
          {mode === 'demo' && !minutesOk && <p className="bad" role="alert">Deadlines must be positive minutes (at most 30 days) with accept_by &lt; submit_by &lt; review_by.</p>}
          {mode === 'demo' && !rewardOk && <p className="bad" role="alert">Reward must be at least 0.001 SOL, with at most 9 decimals.</p>}
        </div>
        <div className="card">
          <h3>Fine Print verdict</h3>
          {!sponsor && <p>Connect a wallet (or pick a burner on localnet).</p>}
          {sponsor && !isPk(contributor) && <p>Enter the invited contributor's wallet address.</p>}
          {compiled && !compiled.ok && <div data-testid="blocked">
            <p className="bad"><b>BLOCKED.</b> You cannot fund until these are fixed:</p>
            {compiled.issues.map((i, k) => (
              <div key={k} className="issue">
                <p><b>[{i.kind}] {i.field}</b>: {i.message}</p>
                <ul>{i.quotes.map((q) => <li key={q.clause}>{q.source}: “{q.quote}” <code>{q.clause}</code></li>)}</ul>
              </div>
            ))}
          </div>}
          {packet.conflicts.map((c) => (
            <label key={c._id} className="resolve">Resolve <code>{c._id}</code>: {c.title}
              <select data-testid={`resolve-${c._id}`} value={resolutions[c._id] ?? ''} onChange={(e) => setResolutions({...resolutions, [c._id]: e.target.value})}>
                <option value="">(unresolved)</option>
                {c.claims.map((cid) => { const cc = packet.clauses.find((x) => x._id === cid); return <option key={cid} value={cid}>{cid}: “{cc?.quote}”</option> })}
              </select>
            </label>
          ))}
          {compiled?.ok && <>
            <p className="good" data-testid="compiled-ok">Terms compiled. This document and these fields are what the program will lock.</p>
            <TermsCard doc={compiled.doc} digest={compiled.digest} />
            <p data-testid="fund-summary">You send <b>{sol(BigInt(compiled.doc.amount_lamports))}</b> reward{rent !== null ? <> + <b>{sol(rent)}</b> account rent (stays in the escrow as its receipt)</> : ' + account rent'} + network fee, on <b>{cluster}</b>.</p>
            {stale && <p className="stale" role="alert">The acceptance deadline has passed or is seconds away. <button className="small" data-testid="refresh-deadlines" onClick={refreshNow}>Recompute demo deadlines from now</button> then review the terms again.</p>}
            <button data-testid="fund" disabled={!actor || busy || stale} onClick={fund}>{busy ? 'Simulating & waiting for signature…' : `Create & fund escrow: ${sol(BigInt(compiled.doc.amount_lamports))} + rent`}</button>
          </>}
          <TxFeedback result={result} cluster={cluster} p="fund" okLabel="Funded" />
        </div>
      </div>
    </section>
  )
}
