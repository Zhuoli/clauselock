import {test, expect, type Page} from '@playwright/test'

const shot = (page: Page, name: string) => process.env.SHOTS ? page.screenshot({path: `docs/screens/${name}.png`, fullPage: true}) : Promise.resolve()

async function as(page: Page, role: 'sponsor' | 'contributor' | 'third') {
  await page.getByTestId('identity').selectOption(`burner:${role}`)
  await expect(page.getByTestId('actor')).toContainText(`burner:${role}`)
  await page.getByTestId('airdrop').click()
  await expect(page.getByTestId('balance')).toContainText(/[1-9][\d.,]* SOL/)
}

async function compileAndFund(page: Page, mins: [string, string, string]) {
  await page.goto('/#view=sponsor&cluster=localnet')
  await expect(page.getByTestId('program-missing')).toHaveCount(0)
  await as(page, 'sponsor')
  await page.getByTestId('tab-sponsor').click()
  await page.getByTestId('use-burner-contributor').click()
  // Fine Print blocks the listing-vs-terms deadline conflict until the sponsor resolves it.
  await expect(page.getByTestId('blocked')).toContainText('Deadline: October 14')
  await shot(page, '1-sponsor-blocked')
  await expect(page.getByTestId('fund')).toHaveCount(0)
  await page.getByTestId('min-accept_by').fill(mins[0])
  await page.getByTestId('min-submit_by').fill(mins[1])
  await page.getByTestId('min-review_by').fill(mins[2])
  await page.getByTestId('resolve-conflict.demo.deadline').selectOption('clause.demo.deadline.terms')
  await expect(page.getByTestId('compiled-ok')).toBeVisible()
  await shot(page, '2-sponsor-compiled')
  await expect(page.getByTestId('terms-card')).toContainText('clause.demo.deadline.terms')
  await page.getByTestId('fund').click()
  await expect(page.getByTestId('fund-ok')).toBeVisible()
  await expect(page.getByTestId('status-state')).toHaveText('Funded')
  return page.getByTestId('share-link').inputValue()
}

test('happy path: compile → fund → verify & accept → submit → approve → third party pays', async ({page}) => {
  const share = await compileAndFund(page, ['5', '10', '15'])
  const escrow = new URLSearchParams(new URL(share).hash.slice(1)).get('escrow')!

  // Contributor opens the share link (terms travel in the URL fragment).
  await page.goto(share.replace('view=escrow', 'view=contributor'))
  await as(page, 'contributor')
  await page.getByTestId('tab-contributor').click()
  await page.getByTestId('escrow-input').fill(escrow)
  await page.getByTestId('load-escrow').click()
  await expect(page.getByTestId('checks')).toContainText('every field matches')
  await expect(page.getByTestId('checks')).toContainText('matches')
  await expect(page.getByTestId('accept')).toBeDisabled() // disclosure not yet acknowledged
  await page.getByTestId('ack').check()
  await shot(page, '3-contributor-verify')
  await page.getByTestId('accept').click()
  await expect(page.getByTestId('state')).toHaveText('Accepted')
  await page.getByTestId('evidence').fill('https://example.org/explainer @ commit abc123')
  await page.getByTestId('submit-evidence').click()
  await expect(page.getByTestId('state')).toHaveText('Submitted')

  await as(page, 'sponsor')
  await page.getByTestId('tab-escrow').click()
  await page.getByTestId('status-escrow-input').fill(escrow)
  await page.getByTestId('status-load').click()
  await expect(page.getByTestId('can-table')).toContainText('can_approve')
  await page.getByTestId('approve').click()
  await expect(page.getByTestId('status-state')).toHaveText('Approved')

  await as(page, 'third')
  await page.getByTestId('refund').count().then((n) => expect(n).toBe(0)) // no refund branch once approved
  await page.getByTestId('pay').click()
  await expect(page.getByTestId('status-state')).toHaveText('Paid')
  await expect(page.getByTestId('timeline')).toContainText('Paid to contributor, triggered by')
  await expect(page.getByTestId('timeline')).toContainText('clause.demo.review')
  await shot(page, '4-status-paid')
})

test('refund path: early refund is rejected with the program reason, then succeeds after accept_by', async ({page}) => {
  await compileAndFund(page, ['0.25', '0.5', '0.75'])
  await as(page, 'third')
  await page.getByTestId('refund').click()
  await expect(page.getByTestId('status-tx-error')).toContainText('RefundNotYetAvailable')
  await expect(page.getByTestId('can-table')).toContainText('Refund opens at')
  await page.waitForTimeout(17_000)
  await page.getByTestId('status-load').click()
  await page.getByTestId('refund').click()
  await expect(page.getByTestId('status-state')).toHaveText('Refunded')
  await expect(page.getByTestId('timeline')).toContainText('Refunded to sponsor')
})
