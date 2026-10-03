// Scripted screen recording of the ClauseLock web UI (localnet, burner wallets) + slides.
// Needs: a local validator with the program deployed and Vite on :5173. Writes out/raw.webm and out/scenes.json.
import {chromium, type Page, type Locator} from 'playwright'
import {Connection, Keypair, LAMPORTS_PER_SOL} from '@solana/web3.js'
import {readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmSync} from 'node:fs'
import {slides} from './slides.ts'

const BASE = 'http://127.0.0.1:5173'
const OUT = process.env.OUT ?? 'out'
const NAR: {id: string}[] = JSON.parse(readFileSync(process.env.NAR ?? 'narration.json', 'utf8'))
const dur: Record<string, number> = JSON.parse(readFileSync(`${OUT}/durations.json`, 'utf8'))
const PAD = 0.9
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const conn = new Connection('http://127.0.0.1:8899', 'confirmed')
const roles = ['sponsor', 'contributor', 'third'] as const
const keys = Object.fromEntries(roles.map((r) => [r, Keypair.generate()])) as Record<(typeof roles)[number], Keypair>
for (const r of roles) { const s = await conn.requestAirdrop(keys[r].publicKey, 5 * LAMPORTS_PER_SOL); await conn.confirmTransaction(s, 'confirmed') }

rmSync(`${OUT}/vid`, {recursive: true, force: true}); mkdirSync(`${OUT}/vid`, {recursive: true})
const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--hide-scrollbars']})
const ctx = await browser.newContext({viewport: {width: 1280, height: 720}, recordVideo: {dir: `${OUT}/vid`, size: {width: 1280, height: 720}}})
await ctx.addInitScript((seed) => {
  for (const [r, sk] of Object.entries(seed)) if (!localStorage.getItem(`clauselock:burner:${r}`)) localStorage.setItem(`clauselock:burner:${r}`, sk as string)
}, Object.fromEntries(roles.map((r) => [r, JSON.stringify(Array.from(keys[r].secretKey))])))
const page = await ctx.newPage()
const t0 = Date.now()
const scenes: {id: string; start: number; end: number}[] = []

async function scene(id: string, fn: () => Promise<void>) {
  const start = (Date.now() - t0) / 1000
  await fn()
  const need = start + dur[id] + PAD
  const now = (Date.now() - t0) / 1000
  if (now < need) await sleep((need - now) * 1000)
  scenes.push({id, start, end: (Date.now() - t0) / 1000})
  console.log(id, start.toFixed(1), ((Date.now() - t0) / 1000).toFixed(1))
}
const HL = `.cl-hl{outline:4px solid #f4b400 !important;outline-offset:3px;border-radius:6px;transition:outline .2s}`
async function hl(l: Locator, ms = 900) {
  await l.scrollIntoViewIfNeeded()
  await l.evaluate((el) => el.classList.add('cl-hl')); await sleep(ms); await l.evaluate((el) => el.classList.remove('cl-hl'))
}
async function click(l: Locator) { await hl(l, 600); await l.click() }
async function scrollTo(l: Locator) { await l.evaluate((el) => el.scrollIntoView({behavior: 'smooth', block: 'center'})); await sleep(700) }
async function slide(id: string) { await page.setContent(slides[id]); }
async function app(hash: string) { await page.goto(`${BASE}/#${hash}`); await page.addStyleTag({content: HL}) }
async function as(role: string) {
  await page.getByTestId('identity').selectOption(`burner:${role}`)
  await page.getByTestId('actor').filter({hasText: `burner:${role}`}).waitFor()
  await hl(page.getByTestId('actor'), 500)
}

let escrow = '', share = ''
const actions: Record<string, () => Promise<void>> = {}
actions.blocked = (async () => {
  await app('view=sponsor&cluster=localnet'); await as('sponsor')
  await page.getByTestId('tab-sponsor').click()
  await click(page.getByTestId('use-burner-contributor'))
  await page.getByTestId('blocked').waitFor()
  await sleep(1500); await hl(page.getByTestId('blocked'), 3500)
})
actions.fund = (async () => {
  for (const [k, v] of [['accept_by', '5'], ['submit_by', '10'], ['review_by', '15']]) await page.getByTestId(`min-${k}`).fill(v)
  const sel = page.getByTestId('resolve-conflict.demo.deadline'); await hl(sel, 700); await sel.selectOption('clause.demo.deadline.terms')
  await page.getByTestId('compiled-ok').waitFor()
  await scrollTo(page.getByTestId('terms-card')); await hl(page.getByTestId('terms-card'), 2500)
  await scrollTo(page.getByTestId('fund-summary')); await hl(page.getByTestId('fund-summary'), 1500)
  await click(page.getByTestId('fund'))
  await page.getByTestId('fund-ok').waitFor()
  await page.getByTestId('status-state').filter({hasText: 'Funded'}).waitFor()
  share = await page.getByTestId('share-link').inputValue()
  escrow = new URLSearchParams(new URL(share).hash.slice(1)).get('escrow')!
  await page.evaluate(() => window.scrollTo({top: 0, behavior: 'smooth'})); await sleep(600)
  await hl(page.getByTestId('status-state'), 1200)
})
actions.accept = (async () => {
  await page.goto(share.replace('view=escrow', 'view=contributor')); await page.addStyleTag({content: HL})
  await as('contributor')
  await page.getByTestId('tab-contributor').click()
  await page.getByTestId('escrow-input').fill(escrow); await click(page.getByTestId('load-escrow'))
  await page.getByTestId('checks').filter({hasText: 'every field matches'}).waitFor()
  await hl(page.getByTestId('checks'), 3500)
  await scrollTo(page.getByTestId('accept')); await hl(page.getByTestId('accept'), 1500)
  await click(page.getByTestId('ack'))
  await click(page.getByTestId('accept'))
  await page.getByTestId('state').filter({hasText: 'Accepted'}).waitFor(); await hl(page.getByTestId('tx-ok'), 1200)
})
actions.settle = (async () => {
  const ev = page.getByTestId('evidence'); await scrollTo(ev)
  await ev.pressSequentially('https://github.com/contributor/explainer @ commit 4f2a9c1', {delay: 18})
  await click(page.getByTestId('submit-evidence'))
  await page.getByTestId('state').filter({hasText: 'Submitted'}).waitFor()
  await as('sponsor')
  await page.getByTestId('tab-escrow').click()
  await page.getByTestId('status-escrow-input').fill(escrow); await page.getByTestId('status-load').click()
  await page.getByTestId('evidence-match').waitFor(); await scrollTo(page.getByTestId('evidence-match')); await hl(page.getByTestId('evidence-match'), 1000)
  await click(page.getByTestId('approve'))
  await page.getByTestId('status-state').filter({hasText: 'Approved'}).waitFor()
  await page.evaluate(() => window.scrollTo({top: 0, behavior: 'smooth'})); await sleep(500)
  await as('third')
  await click(page.getByTestId('pay'))
  await page.getByTestId('status-state').filter({hasText: 'Paid'}).waitFor()
  await scrollTo(page.getByTestId('timeline')); await hl(page.getByTestId('timeline'), 3000)
})
for (const {id} of NAR) await scene(id, actions[id] ?? (() => slide(id)))
await sleep(800)
const vpath = await page.video()!.path()
await ctx.close(); await browser.close()
renameSync(vpath, `${OUT}/raw.webm`)
writeFileSync(`${OUT}/scenes.json`, JSON.stringify(scenes, null, 1))
console.log('done', scenes.at(-1)!.end.toFixed(1), 's')
