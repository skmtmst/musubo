import { test, expect } from '@playwright/test'
import { base, openFixture } from './first-steps-guide-fixture.mjs'

test('埋まっている卓が多くても空き席数を隠さず、全文を確認できる', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, { width: 1440, height: 1000, initialGuide: { phase: 'done' } })
  const standard = { otaCapacity: 8, lineCapacity: 6, walkInCapacity: 6 }
  await page.route('**/api/restaurant-test/inventory/day?**', route => route.fulfill({ json: {
    success: true,
    allocation: { version: 4, standard, day: null, hoursStatus: 'open' },
    closures: [],
    data: [{
      id: 'crowded-slot', starts_at: '2026-11-25T10:00:00.000Z', slot_minutes: 30,
      total_capacity: 26, reserved_count: 22, freeSeats: 4, occupied_seats: 22,
      occupiedTableIds: ['tbl-8', 'tbl-1', 'tbl-2', 'tbl-3', 'tbl-4', 'tbl-6', 'tbl-7'],
      ota_capacity: 8, line_capacity: 6, walk_in_capacity: 6, allocationSource: 'standard',
    }],
  } }))
  await page.goto(`${base}/restaurant-test/inventory`)
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: '19:00', exact: true }) })
  const codes = '個室A・T1〜T4・C1・C2'
  const occupied = row.getByText(codes, { exact: true })
  const free = row.getByRole('cell', { name: '4席', exact: true })
  await expect(occupied).toHaveAttribute('title', codes)
  for (const width of [1440, 1152]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect(free).toBeVisible()
    const clipping = await occupied.evaluate(element => {
      const { overflowX, textOverflow } = getComputedStyle(element)
      return { overflowX, textOverflow, clipped: element.scrollWidth > element.clientWidth }
    })
    expect(clipping).toEqual({ overflowX: 'hidden', textOverflow: 'ellipsis', clipped: true })
    const [list, count] = await Promise.all([occupied.boundingBox(), free.boundingBox()])
    expect(list.x + list.width).toBeLessThanOrEqual(count.x)
    await page.screenshot({ path: info.outputPath(`stock-crowded-${width}.png`) })
  }
  await expect(occupied).toHaveAttribute('tabindex', '0')
  await occupied.focus()
  await expect(page.getByRole('tooltip')).toHaveText(codes)
})

for (const [width, height] of [[1440, 900], [390, 844]]) {
  test(`共通配分・日別・時間別を同じ画面から変更できる（${width}px）`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openFixture(page, { width, height, initialGuide: { phase: 'done' } })
    const standard = { otaCapacity: 8, lineCapacity: 6, walkInCapacity: 6 }
    const writes = []
    let version = 4
    let day = null
    let slot = { otaCapacity: 5, lineCapacity: 7, walkInCapacity: 1 }
    await page.route('**/api/restaurant-test/inventory/day?**', route => route.fulfill({ json: {
      success: true,
      allocation: { version, standard, day, hoursStatus: 'open' },
      closures: [],
      data: [{
        id: 'test-slot', starts_at: '2026-11-25T10:00:00.000Z', slot_minutes: 30, reserved_count: 4,
        total_capacity: 26, freeSeats: 20, occupied_seats: 6, occupiedTableIds: ['tbl-1'],
        ota_capacity: (slot ?? day ?? standard).otaCapacity,
        line_capacity: (slot ?? day ?? standard).lineCapacity,
        walk_in_capacity: (slot ?? day ?? standard).walkInCapacity,
        allocationSource: slot ? 'slot' : day ? 'day' : 'standard',
      }],
    } }))
    await page.route('**/api/restaurant-test/inventory/allocation?**', route => {
      const body = route.request().postDataJSON()
      writes.push(body)
      if (body.scope === 'standard') Object.assign(standard, body.allocation)
      if (body.scope === 'day') day = body.allocation
      if (body.scope === 'slot') slot = body.allocation
      version += 1
      return route.fulfill({ json: { success: true, data: { version } } })
    })
    const modal = page.getByRole('dialog')
    const open = name => page.getByRole('button', { name, exact: true }).click()
    const change = (name, value) => modal.getByRole('spinbutton', { name, exact: true }).fill(value)
    await page.goto(`${base}/restaurant-test/inventory`)
    await expect(page.getByRole('heading', { name: '営業日の基本配分' })).toBeVisible()
    await page.screenshot({ path: info.outputPath('stock.png') })
    await open('基本配分をまとめて変更')
    await change('予約サイト（グルメサイト）', '9')
    await change('当日（ウォークイン）', '4')
    await expect(modal.getByRole('button', { name: '基本配分を保存' })).toBeEnabled()
    const [cancel, save] = await Promise.all([
      modal.getByRole('button', { name: 'キャンセル' }).boundingBox(),
      modal.getByRole('button', { name: '基本配分を保存' }).boundingBox(),
    ])
    expect(save.x).toBeGreaterThanOrEqual(cancel.x + cancel.width)
    await page.screenshot({ path: info.outputPath('stock-standard.png') })
    await modal.getByRole('button', { name: '基本配分を保存' }).click()
    await expect(modal).toHaveCount(0)
    expect(writes[0]).toMatchObject({ scope: 'standard', expectedVersion: 4, allocation: { otaCapacity: 9, lineCapacity: 6, walkInCapacity: 4 } })
    await expect(page.getByText('この時間だけ', { exact: true })).toBeVisible()
    await open('この日の配分を変更')
    await change('当日（ウォークイン）', '3')
    await page.screenshot({ path: info.outputPath('stock-day.png') })
    await modal.getByRole('button', { name: 'この日だけ保存' }).click()
    await expect(modal).toHaveCount(0)
    await expect(page.getByText('この時間だけ', { exact: true })).toBeVisible()
    await open('19:00の配分を変更')
    await expect(modal.getByRole('spinbutton', { name: '当日（ウォークイン）' })).toHaveValue('1')
    await page.screenshot({ path: info.outputPath('stock-slot.png') })
    await modal.getByRole('button', { name: 'この日の配分に戻す' }).click()
    await expect(modal).toHaveCount(0)
    await expect(page.getByText('この日だけ', { exact: true })).toBeVisible()
    expect(writes[2]).toMatchObject({ scope: 'slot', expectedVersion: 6, startsAt: '2026-11-25T10:00:00.000Z', allocation: null })
    await page.reload()
    await expect(page.getByText('この日だけ', { exact: true })).toBeVisible()
  })
}
