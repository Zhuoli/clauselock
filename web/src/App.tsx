import {createContext, useContext, useEffect, useMemo, useState} from 'react'
import {Connection, LAMPORTS_PER_SOL} from '@solana/web3.js'
import {ConnectionProvider, WalletProvider, useConnection, useWallet} from '@solana/wallet-adapter-react'
import {WalletModalProvider, WalletMultiButton} from '@solana/wallet-adapter-react-ui'
import {CLUSTERS, asCluster, burnerActor, programIdFor, readHash, short, sol, type Actor, type ClusterName} from './lib'
import {SponsorView} from './SponsorView'
import {ContributorView} from './ContributorView'
import {EscrowView} from './EscrowView'

type Ctx = {cluster: ClusterName; conn: Connection; actor: Actor | null; setView: (v: View, escrow?: string) => void; refreshBalance: () => void}
const AppCtx = createContext<Ctx>(null as any)
export const useApp = () => useContext(AppCtx)
type View = 'sponsor' | 'contributor' | 'escrow'
const asView = (v: unknown): View | null => (v === 'sponsor' || v === 'contributor' || v === 'escrow' ? v : null)

export function Root() {
  const [cluster, setCluster] = useState<ClusterName>(asCluster(readHash().cluster) ?? asCluster(localStorage.getItem('clauselock:cluster')) ?? 'localnet')
  useEffect(() => {
    localStorage.setItem('clauselock:cluster', cluster)
    // Keep the URL in sync so a reload cannot restore a different cluster from an old fragment.
    const p = new URLSearchParams(location.hash.slice(1)); if (p.get('cluster') !== cluster) { p.set('cluster', cluster); history.replaceState(null, '', `#${p.toString()}`) }
  }, [cluster])
  return (
    <ConnectionProvider endpoint={CLUSTERS[cluster]} config={{commitment: 'confirmed'}}>
      {/* No adapters listed: Phantom (and other Wallet Standard wallets) are detected automatically. */}
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <Shell cluster={cluster} setCluster={setCluster} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

function Shell({cluster, setCluster}: {cluster: ClusterName; setCluster: (c: ClusterName) => void}) {
  const {connection} = useConnection()
  const wallet = useWallet()
  const h = readHash()
  const [view, setViewState] = useState<View>(asView(h.view) ?? 'sponsor')
  const [escrow, setEscrow] = useState<string>(h.escrow ?? '')
  const [identity, setIdentity] = useState<string>(localStorage.getItem('clauselock:identity') ?? (cluster === 'localnet' ? 'burner:sponsor' : 'wallet'))
  useEffect(() => localStorage.setItem('clauselock:identity', identity), [identity])
  const [programOk, setProgramOk] = useState<boolean | null>(null)
  const [balance, setBalance] = useState<number | null>(null)

  const actor: Actor | null = useMemo(() => {
    if (identity.startsWith('burner:')) return cluster === 'localnet' ? burnerActor(identity.slice(7)) : null
    if (!wallet.publicKey || !wallet.sendTransaction) return null
    return {label: wallet.wallet?.adapter.name ?? 'wallet', publicKey: wallet.publicKey, send: (tx, conn) => wallet.sendTransaction(tx, conn)}
  }, [identity, cluster, wallet.publicKey, wallet.sendTransaction, wallet.wallet])

  useEffect(() => {
    let live = true
    connection.getAccountInfo(programIdFor(cluster)).then((i) => live && setProgramOk(!!i?.executable)).catch(() => live && setProgramOk(false))
    return () => { live = false }
  }, [connection, cluster])
  const refreshBalance = () => { if (actor) connection.getBalance(actor.publicKey, 'confirmed').then(setBalance).catch(() => setBalance(null)) }
  useEffect(() => { setBalance(null); refreshBalance(); const t = setInterval(refreshBalance, 10000); return () => clearInterval(t) }, [actor?.publicKey.toBase58(), connection])
  const [airdropMsg, setAirdropMsg] = useState(''); const [airdropping, setAirdropping] = useState(false)

  const setView = (v: View, e?: string) => {
    setViewState(v); if (e !== undefined) setEscrow(e)
    const p = new URLSearchParams(location.hash.slice(1)); p.set('view', v); p.set('cluster', cluster); if (e) p.set('escrow', e)
    history.replaceState(null, '', `#${p.toString()}`)
  }
  const airdrop = async () => {
    if (!actor || airdropping) return
    setAirdropping(true); setAirdropMsg('')
    try {
      const sig = await connection.requestAirdrop(actor.publicKey, 5 * LAMPORTS_PER_SOL)
      const bh = await connection.getLatestBlockhash('confirmed')
      const res = await connection.confirmTransaction({signature: sig, ...bh}, 'confirmed')
      if (res.value.err) setAirdropMsg(`Airdrop failed: ${JSON.stringify(res.value.err)}`)
    } catch (e: any) { setAirdropMsg(`Airdrop failed: ${e?.message ?? e}`) }
    finally { setAirdropping(false); refreshBalance() }
  }

  return (
    <AppCtx.Provider value={{cluster, conn: connection, actor, setView, refreshBalance}}>
      <header>
        <div className="brand"><b>ClauseLock</b><span>the terms you read are the terms that execute</span></div>
        <div className="controls">
          <label>Cluster{' '}
            <select data-testid="cluster" value={cluster} onChange={(e) => { const c = e.target.value as ClusterName; setCluster(c); if (c !== 'localnet' && identity.startsWith('burner:')) setIdentity('wallet') }}>
              <option value="localnet">localnet</option><option value="devnet">devnet</option>
            </select>
          </label>
          <label>Act as{' '}
            <select data-testid="identity" value={identity} onChange={(e) => setIdentity(e.target.value)}>
              <option value="wallet">Browser wallet (Phantom)</option>
              {cluster === 'localnet' && <>
                <option value="burner:sponsor">Burner: sponsor</option>
                <option value="burner:contributor">Burner: contributor</option>
                <option value="burner:third">Burner: third party</option>
              </>}
            </select>
          </label>
          {identity === 'wallet' ? <WalletMultiButton /> : actor && <span className="pill" data-testid="actor">{actor.label} {short(actor.publicKey)}</span>}
          {actor && <span className="pill" data-testid="balance">{balance === null ? '…' : sol(balance)}</span>}
          {actor && cluster === 'localnet' && <button className="small" data-testid="airdrop" disabled={airdropping} onClick={airdrop}>{airdropping ? 'Airdropping…' : 'Airdrop 5 SOL'}</button>}
          {airdropMsg && <span className="pill bad" role="alert">{airdropMsg}</span>}
        </div>
      </header>
      <div className={`banner ${cluster}`}>
        {cluster.toUpperCase()} · program <code>{programIdFor(cluster).toBase58()}</code>{' '}
        {programOk === false && <b data-testid="program-missing">· not deployed on this cluster</b>}
        {cluster === 'devnet' && ' · test SOL only, never mainnet'}
      </div>
      <nav>
        {(['sponsor', 'contributor', 'escrow'] as View[]).map((v) => (
          <button key={v} data-testid={`tab-${v}`} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
            {v === 'sponsor' ? '1 · Sponsor: compile & fund' : v === 'contributor' ? '2 · Contributor: verify & accept' : '3 · Escrow status'}
          </button>
        ))}
      </nav>
      {/* Remount the views on a cluster change: no verified state, snapshot or pending action carries across networks. */}
      <main key={cluster}>
        {view === 'sponsor' && <SponsorView onCreated={(pda) => setView('escrow', pda)} />}
        {view === 'contributor' && <ContributorView escrow={escrow} setEscrow={setEscrow} />}
        {view === 'escrow' && <EscrowView escrow={escrow} setEscrow={setEscrow} />}
      </main>
      <footer>Devnet prototype · not audited · approval is at the sponsor's discretion; ClauseLock prevents hidden term changes and unfunded promises, not every case of nonpayment.</footer>
    </AppCtx.Provider>
  )
}
