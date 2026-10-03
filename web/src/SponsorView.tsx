import {useEffect, useMemo, useState} from 'react'
import {PublicKey} from '@solana/web3.js'
import * as cl from '../../sdk/index.ts'
import {compileTerms, withDemoDeadlines, type Packet} from '../../fineprint/adapter.ts'
import demoPacket from '../../fineprint/demo-bounty.packet.json'
import {useApp} from './App'
import {burnerActor, chainNow, explorerTx, run, saveTerms, shareLink, type TxResult} from './lib'
import {TermsCard} from './TermsCard'

const isPk = (s: string) => { try { new PublicKey(s); return true } catch { return false } }

export function SponsorView({onCreated}: {onCreated: (pda: string) => void}) {
  const {cluster, conn, actor} = useApp()
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

  useEffect(() => { chainNow(conn).then((t) => setNow(Number(t))) }, [conn, mode, minutes])

  const effective = useMemo(() => mode === 'demo'
    ? withDemoDeadlines(packet, now, {accept_by: minutes.accept_by * 60, submit_by: minutes.submit_by * 60, review_by: minutes.review_by * 60}, String(Math.round(Number(reward) * 1e9)))
    : packet, [packet, mode, now, minutes, reward])

  const sponsor = actor?.publicKey.toBase58() ?? ''
  const compiled = useMemo(() => {
    if (!sponsor || !isPk(contributor)) return null
    return compileTerms({packet: effective, sponsor, contributor, escrowId,
      resolutions: Object.entries(resolutions).filter(([, w]) => w).map(([conflict, winningClaim]) => ({conflict, winningClaim, resolvedBy: 'sponsor' as const}))})
  }, [effective, sponsor, contributor, escrowId, resolutions])

  const onFile = async (f: File) => { try { setPacket(JSON.parse(await f.text())); setResolutions({}) } catch (e: any) { alert('Not a valid packet JSON: ' + e.message) } }

  const fund = async () => {
    if (!actor || !compiled?.ok) return
    setBusy(true); setResult(null)
    const d = compiled.doc
    const terms: cl.Terms = {sponsor: actor.publicKey, contributor: new PublicKey(contributor), escrowId: BigInt(escrowId), amount: BigInt(d.amount_lamports),
      acceptBy: BigInt(d.accept_by), submitBy: BigInt(d.submit_by), reviewBy: BigInt(d.review_by), refundPolicy: 0, docDigest: Buffer.from(compiled.digest, 'hex')}
    const r = await run(conn, actor, [cl.createFundIx(terms)])
    setResult(r); setBusy(false)
    if (r.ok) {
      const pda = cl.escrowPda(actor.publicKey, BigInt(escrowId)).toBase58()
      saveTerms(pda, d)
      localStorage.setItem('clauselock:last-share', shareLink(cluster, pda, d))
      setTimeout(() => onCreated(pda), 600)
    }
  }

  return (
    <section>
      <h2>Sponsor: Fine Print reads the rules, you resolve conflicts, the program locks the result</h2>
      <div className="grid">
        <div className="card">
          <h3>Rule packet</h3>
          <p><b>{packet.bounty.title}</b> · {packet.ruleSources.length} sources · {packet.clauses.length} clauses · {packet.conflicts.length} recorded conflicts</p>
          <label>Load another packet (Fine Print JSON) <input type="file" accept=".json" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} /></label>
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
            <label>Reward SOL <input data-testid="reward" value={reward} onChange={(e) => setReward(e.target.value)} /></label>
          </div>}
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
            <button data-testid="fund" disabled={!actor || busy} onClick={fund}>{busy ? 'Simulating & sending…' : `Create & fund escrow (${reward} SOL + rent)`}</button>
          </>}
          {result && (result.ok
            ? <p className="good" data-testid="fund-ok">Funded · <a href={explorerTx(cluster, result.sig)} target="_blank">{result.sig.slice(0, 16)}…</a></p>
            : <p className="bad" data-testid="fund-error">Program rejected: <b>{result.error}</b></p>)}
        </div>
      </div>
    </section>
  )
}
