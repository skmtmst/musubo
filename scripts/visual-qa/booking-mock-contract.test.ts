import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type Availability = {
  by_staff: Array<{ staff_id: string; display_name: string; slots: Array<{ date: string; start: string; end: string }> }>
  closed_dates: string[]
}

type EventBookingsPage = {
  items: Array<{ id: string; event_id: string; slot_id: string; status: string }>
  total: number
  limit: number
  sort: Array<{ field: string; direction: string }>
}

describe('予約の空き枠：偽 API と Worker の応答契約', () => {
  let child: ChildProcess
  let baseUrl: string

  beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('空きポートを取得できませんでした'))
        server.close((error) => error ? reject(error) : resolve(address.port))
      })
    })
    baseUrl = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [fileURLToPath(new URL('./mock-api.mjs', import.meta.url))], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    })
    for (let attempt = 0; attempt < 250; attempt++) {
      try {
        if ((await fetch(`${baseUrl}/__mock-fingerprint`)).ok) return
      } catch { /* 起動待ち */ }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('偽 API が起動しませんでした')
  })

  afterAll(() => { child?.kill('SIGTERM') })

  async function availability(query: URLSearchParams) {
    const response = await fetch(`${baseUrl}/api/booking/admin/availability?${query}`)
    expect(response.status).toBe(200)
    return response.json()
  }

  it('イベントの予約集計は画面が読む人数と定員を返す', async () => {
    const response = await fetch(`${baseUrl}/api/events/admin/events/ev-1/bookings/summary`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ confirmed: 3, confirmedSeats: 3, totalCapacity: 36, requested: 2, waitlist: 2, cancelled: 1 })
  })

  it('イベント予約の全件を重複なく有限ページで返し、最終頁の次は空になる', async () => {
    const read = async (page: number) => {
      const response = await fetch(`${baseUrl}/api/events/admin/events/ev-1/bookings?page=${page}&limit=2`)
      expect(response.status).toBe(200)
      return response.json() as Promise<EventBookingsPage>
    }
    const first = await read(1)
    expect(first).toMatchObject({ total: 6, limit: 2, sort: [{ field: 'requested_at', direction: 'desc' }, { field: 'id', direction: 'desc' }] })
    const ids = first.items.map(item => item.id)
    for (let page = 2; page <= Math.ceil(first.total / first.limit); page += 1) {
      const result = await read(page)
      expect(result.total).toBe(first.total)
      ids.push(...result.items.map(item => item.id))
    }
    expect(ids).toHaveLength(first.total)
    expect(new Set(ids).size).toBe(first.total)
    expect((await read(4)).items).toEqual([])
  })

  it('イベント・開催回・状態で絞った後の総件数を返す', async () => {
    const read = async (event: string, query: string) => fetch(`${baseUrl}/api/events/admin/events/${event}/bookings?${query}`)
      .then(response => response.json() as Promise<EventBookingsPage>)
    const confirmed = await read('ev-1', 'slot_id=event-slot-1&status=confirmed&limit=2')
    expect(confirmed.total).toBe(3)
    expect(confirmed.items).toHaveLength(2)
    expect(confirmed.items.every(item => item.event_id === 'ev-1' && item.slot_id === 'event-slot-1' && item.status === 'confirmed')).toBe(true)
    expect(await read('ev-1', 'slot_id=missing')).toMatchObject({ items: [], total: 0 })
    expect(await read('missing', '')).toMatchObject({ items: [], total: 0 })
  })

  it.each([
    ['2026-09-03', false],
    ['2026-10-02', false],
    ['2026-10-02', true],
  ])('一括取得は by_menu、単件取得は by_staff を返す（%s・店舗ルール %s）', async (from, storeRules) => {
    const query = new URLSearchParams({ account_id: 'visual-qa-account', from, to: from })
    if (storeRules) query.set('apply_store_rules', '1')
    const menus = await fetch(`${baseUrl}/api/booking/admin/menus`).then((response) => response.json()) as { menus: Array<{ id: string }> }
    const menuIds = menus.menus.slice(0, 2).map((menu) => menu.id)
    expect(menuIds).toHaveLength(2)
    query.set('menu_ids', menuIds.join(','))
    const batch = await availability(query) as { by_menu: Array<Availability & { menu_id: string }> }
    expect(batch.by_menu).toBeInstanceOf(Array)
    expect(batch.by_menu.map((entry) => entry.menu_id)).toEqual(menuIds)
    expect(batch).not.toHaveProperty('success')
    expect(batch).not.toHaveProperty('by_staff')
    for (const entry of batch.by_menu) {
      query.delete('menu_ids')
      query.set('menu_id', entry.menu_id)
      const single = await availability(query) as Availability
      expect(single.by_staff.length).toBeGreaterThan(0)
      expect(single.by_staff[0].slots.length).toBeGreaterThan(0)
      expect(single).not.toHaveProperty('by_menu')
      expect(entry).toEqual({ menu_id: entry.menu_id, ...single })
    }
  })

  it('一括取得のメニューは Worker と同じく空白・重複・空の指定を整理する', async () => {
    const query = new URLSearchParams({
      account_id: 'visual-qa-account', from: '2026-10-02', to: '2026-10-02',
      menu_ids: 'bm-1, bm-2,bm-1,, ',
    })
    const batch = await availability(query) as { by_menu: Array<{ menu_id: string }> }
    expect(batch.by_menu.map((entry) => entry.menu_id)).toEqual(['bm-1', 'bm-2'])
    query.set('menu_ids', '')
    await expect(availability(query)).resolves.toEqual({ by_menu: [] })
  })
})
