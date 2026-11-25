import { routeLocalApi } from './local-api.mjs'

export const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:3101'
export const mock = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:8788'
export const accountId = 'visual-qa-account'

export async function openFixture(page, { width = 1440, height = 1000, initialGuide, firstStep = 'attributes', delayProgress, storeProgress = {}, onMenuSave, menuSaveFailures = [] } = {}) {
  await routeLocalApi({ page })
  await page.setViewportSize({ width, height })
  await page.request.put(`${mock}/api/dashboard/style?accountId=${accountId}`, { data: { style: 'restaurant' } })
  let guide = { phase: 'idle', stepKey: null, procedureIndex: 1, updatedAt: '2026-11-20T00:00:00Z', ...initialGuide }
  await page.route('**/api/getting-started/guide?**', route => {
    if (route.request().method() === 'PUT') {
      const { phase, stepKey, procedureIndex } = route.request().postDataJSON()
      guide = { ...guide, phase, stepKey, procedureIndex }
    }
    return route.fulfill({ json: { success: true, data: guide } })
  })
  await page.addInitScript((account) => {
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
    localStorage.setItem('lh_selected_account', account)
  }, accountId)
  const setup = { tables: false, hours: false, menus: false, reception: false, followup: false, ...storeProgress }
  await page.route('**/api/restaurant-test/setup-progress?**', async route => {
    await delayProgress
    const storeId = new URL(route.request().url()).searchParams.get('storeId')
    await route.fulfill({ json: { success: true, data: { storeId, ...setup } } })
  })
  if (firstStep === 'richMenu') {
    let items = []
    await page.route('**/api/rich-menu-groups?**', route =>
      route.fulfill({ json: { success: true, data: { items, total: items.length } } }))
    await page.route('**/api/dashboard/style?**', async route => {
      if (route.request().method() !== 'PUT') return route.fallback()
      const failure = menuSaveFailures.shift()
      if (failure) return route.fulfill(failure)
      onMenuSave?.(route.request().postDataJSON())
      items = [{ id: 'qa-menu-preset', accountId, status: 'draft' }]
      await route.fulfill({ json: { success: true, data: { version: 2 } } })
    })
  }
  await page.route('**/api/restaurant-test/inventory/allocation?**', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    const body = route.request().postDataJSON()
    setup.reception = body.scope === 'standard' && body.allocation?.lineCapacity > 0
    await route.fulfill({ json: { success: true, data: { version: body.expectedVersion + 1 } } })
  })
  let saves = 0
  await page.route('**/api/restaurant-test/tables?**', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    saves += 1
    if (saves === 1) {
      return route.fulfill({ status: 500, json: { success: false, error: '卓を保存できませんでした' } })
    }
    setup.tables = true
    return route.fulfill({ json: { success: true, data: { id: 'qa-table-1' } } })
  })
  await page.route('**/api/restaurant-test/floors/**', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    return route.fulfill({ json: { success: true, data: route.request().postDataJSON() } })
  })
}
