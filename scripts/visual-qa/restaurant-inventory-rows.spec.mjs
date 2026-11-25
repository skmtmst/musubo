import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { base, openFixture } from './first-steps-guide-fixture.mjs'

for (const width of [1440, 1152]) test(`時間帯の在庫は2行の配分と数を読みやすく表示する ${width}`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, { width, height: 1000, initialGuide: { phase: 'done' } })
  const allocation = { otaCapacity: 8, lineCapacity: 6, walkInCapacity: 6 }
  await page.route('**/api/restaurant-test/inventory/day?**', route => route.fulfill({ json: {
    success: true, allocation: { version: 4, standard: allocation, day: null, hoursStatus: 'open' }, closures: [],
    data: [0, 1].map(index => ({
      id: `row-${index}`, starts_at: `2026-11-25T10:${index ? '30' : '00'}:00.000Z`, slot_minutes: 30,
      total_capacity: 26, reserved_count: 6, freeSeats: 20, occupied_seats: 6, occupiedTableIds: ['tbl-1'],
      ota_capacity: 8, line_capacity: 6, walk_in_capacity: 6, allocationSource: 'standard',
    })),
  } }))
  await page.goto(`${base}/restaurant-test/inventory`)
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: '19:00', exact: true }) })
  await expect(row).toBeVisible()
  const target = process.env.STOCK_ROWS_ARTIFACT
  if (target) { await mkdir(target, { recursive: true }); await page.screenshot({ path: join(target, `${process.env.STOCK_ROWS_VARIANT ?? 'after'}-${width}.png`), animations: 'disabled' }) }
  else await page.screenshot({ path: info.outputPath(`stock-rows-${width}.png`), animations: 'disabled' })
  const measurements = await row.evaluate(element => {
    const cells = [...element.querySelectorAll('td')]
    const rowBox = element.getBoundingClientRect()
    const line = cells[1].querySelector('strong').getBoundingClientRect()
    const source = cells[1].querySelector('span').getBoundingClientRect()
    return { height: rowBox.height, topGap: line.top - rowBox.top, bottomGap: rowBox.bottom - source.bottom,
      numeric: [1, 2, 3, 5, 7].map(index => getComputedStyle(cells[index]).textAlign),
      allocationRightPadding: [1, 2, 3].map(index => getComputedStyle(cells[index]).paddingRight),
      overlaps: cells.some((cell, index) => index > 0 && cell.getBoundingClientRect().left < cells[index - 1].getBoundingClientRect().right - 1),
      overflow: document.documentElement.scrollWidth - window.innerWidth }
  })
  expect(measurements.height).toBeGreaterThanOrEqual(56)
  expect(measurements.topGap).toBeGreaterThanOrEqual(4)
  expect(measurements.bottomGap).toBeGreaterThanOrEqual(4)
  expect(measurements.numeric).toEqual(['right', 'right', 'right', 'right', 'right'])
  expect(new Set(measurements.allocationRightPadding).size).toBe(1)
  expect(measurements.overlaps).toBe(false)
  expect(measurements.overflow).toBe(0)
  const heading = page.getByRole('columnheader', { name: '埋まっている卓' })
  await expect(heading).toHaveText('埋まり')
  expect(await heading.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.getByRole('button', { name: '19:30', exact: true }).click()
  await expect(page.getByRole('button', { name: '19:30', exact: true })).toHaveAttribute('aria-pressed', 'true')
})
