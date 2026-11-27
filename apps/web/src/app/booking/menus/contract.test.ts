// @vitest-environment happy-dom
import { readFileSync as readRawSource } from 'node:fs'
import { readUiSource as readFileSync } from '../../../../scripts/test-ui-source.mjs'
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChannelsTabV8 from '@/v8/booking-menus/channels-tab'
import { V8_TABS } from '@/v8/booking-menus/settings-parts'

vi.mock('@/components/shared/toast', () => ({ ...(() => { const notifyToast = vi.fn(); return { notifyToast, notifySaved: notifyToast } })() }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ROOT = join(process.cwd(), 'src', 'app', 'booking', 'menus')
const LIST = readFileSync(join(ROOT, 'page.tsx'), 'utf8')
const CREATE = readFileSync(join(ROOT, 'new', 'page.tsx'), 'utf8')
const SETTINGS_V8 = readFileSync(join(ROOT, 'settings-v8.tsx'), 'utf8')
// タブの中身は settings-tabs/ に分かれている（見た目・動きは同じ）。
const SETTINGS_MENUS_TAB = readFileSync(join(ROOT, '../../../v8/booking-menus/tabs/menus-tab.tsx'), 'utf8')
const SETTINGS_CSS = readFileSync(join(ROOT, '../../../v8/booking-menus/settings.module.css'), 'utf8')

describe('V8 予約設定', () => {

  it('設計どおり4つの設定入口と、店舗共通・メニュー別の予約ルールを持つ', () => {
    expect(LIST).toContain('受付枠')
    expect(LIST).toContain('休業日')
    expect(LIST).toContain('予約のルール')
    expect(LIST).toContain('いつまで予約を受けるか')
    expect(LIST).toContain('bookingApi.saveSettings(accountId, {')
    expect(LIST).toContain('expectedVersion: draft.version')
    expect(CREATE).toContain('空ならお店全体のきまり（予約のルール）を使います')
    expect(CREATE).toContain('booking_window_days:')
    expect(CREATE).toContain('cutoff_hours_before:')
    expect(CREATE).toContain('cancel_deadline_hours_before:')
  })

  it('表示している一覧操作は実際に使える', () => {
    // 分割先のコメントは画面の文言ではない。口が来るまでの「現在準備中です」の案内は （オーナー）で認められた形なので除く。
    expect(LIST.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replaceAll('現在準備中です', '')).not.toContain('準備中')
    expect(LIST).toContain('bookingApi.getSettings(accountId)')
    expect(LIST).toContain('<Pagination page={safePage} pageCount={pageCount}')
    expect(LIST).toContain("label: (visOverride[menu.id] ?? menu.is_active) ? '止める' : '出す'")
    expect(LIST).toContain('bookingApi.patchMenu(accountId, menu.id, version')
    expect(LIST).toContain('visibilityError ? <Notice')
    expect(LIST).not.toContain('メニュー名で検索')
    // メニュー一覧（menus-tab）に CSV の書き出しは置かない。お支払いの記録の書き出しは別のタブ。
    expect(SETTINGS_MENUS_TAB).not.toContain('CSVで書き出す')
  })

  it('読込・失敗・空を同じ空状態として扱わない', () => {
    expect(LIST).toContain("status === 'loading'")
    expect(LIST).toContain("status === 'error'")
    expect(LIST).toContain('<EmptyList')
  })

  it('休業日タブはV8の休業日画面につながる', () => {
    expect(LIST).toContain('<HolidaysTabV8')
  })

  it('編集窓の数値欄へ文字列が入る逃げ道を残さない', () => {
    expect(LIST).not.toContain('BookingMenu[K] | string | null')
    expect(CREATE).toContain('duration_minutes: Number(durationMinutes)')
    expect(CREATE).toContain('base_price: Number(basePrice)')
  })

  it('作成は専用画面だけに寄せ、作成と編集で同じ担当必須の検証を使う', () => {
    expect(CREATE).toContain('bookingMenuError({')
    expect(CREATE).toContain('bookingMenuError({')
    expect(CREATE).toContain('assignedStaffCount: assignedIds.length')
    expect(LIST).toContain('/booking/menus/new?menu=${menu.id}')
    expect(LIST).not.toContain('bookingApi.createMenu(')
    expect(LIST).not.toContain("'新規メニュー'")
  })

  it('日時の表示は予約設定内の共通整形を使う', () => {
    // readUiSource は共通整形の定義まで読むので、入口だけを検査する。
    const entry = readRawSource(join(ROOT, '../../../v8/booking-menus/tabs/rules-tab.tsx'), 'utf8')
    expect(entry).toContain("from '../lib/format-time'")
    expect(entry).not.toContain('function bookingWindowEnd(')
    expect(entry).not.toContain('function businessHourSummary(')
  })

  it('営業時間の要約で存在しない末尾を断言しない', () => {
    expect(LIST).not.toContain('.at(-1)!')
  })

  // この状態は booking-settings-boards-nodes.test.tsx で実際に描いて確認する。

  it('P6EdLW: 1152ではメニュー表の担当・30日を畳む', () => {
    expect(SETTINGS_CSS).toContain('@container (max-width: 1080px)')
    expect(SETTINGS_CSS).toMatch(/\.colStaff,\s*\.colCount\s*\{\s*display:\s*none/)
  })

  // この状態は booking-settings-boards-nodes.test.tsx で実際に描いて確認する。

  it('ZyDd6: 予約経路タブは経路の口から表を作る', () => {
    expect(V8_TABS.find(tab => tab.key === 'channels')).toEqual({ key: 'channels', label: '予約経路の連携', node: 'ZyDd6' })
    expect(SETTINGS_V8).toContain('/api/booking/admin/channels?account_id=')
    expect(SETTINGS_V8).toContain('スタッフの Google カレンダー')
    expect(SETTINGS_V8).toContain('data-design-node="wJYQb"')
  })

  it('wJYQb: 指名なしの自動割り当てだけを保存できる決まりにする', () => {
    expect(SETTINGS_V8).toContain('/api/booking/admin/channels/settings?account_id=')
    expect(SETTINGS_V8).toContain('指名なしの予約は、その時間に空いているスタッフへ自動で割り当て')
  })
})

describe('wJYQb 自動割り当ての保存・権限・失敗', () => {
  function installChannels(saveStatus = 200) {
    const requests: Array<{ accountId: string | null; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status, headers: { 'Content-Type': 'application/json' },
      })
      if (url.pathname === '/api/booking/admin/channels/settings') {
        requests.push({ accountId: url.searchParams.get('account_id'), body: JSON.parse(String(init?.body)) })
        expect(init?.method).toBe('PUT')
        return saveStatus === 200 ? json({ ok: true }) : json({ error: 'test failure' }, saveStatus)
      }
      if (url.pathname === '/api/booking/admin/channels') {
        return json({ success: true, data: { timeZone: 'Asia/Tokyo', staff: [], channels: [], autoAssign: true } })
      }
      if (url.pathname === '/api/booking/admin/conflicts') return json({ success: true, data: { conflicts: [] } })
      throw new Error(`Unexpected API: ${url.pathname}`)
    }))
    return requests
  }

  it('取得済みの設定を表示し、選んだアカウントへ変更を保存する', async () => {
    const requests = installChannels()
    render(React.createElement(ChannelsTabV8, { accountId: 'account-a', canEdit: true }))
    const toggle = await screen.findByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => { toggle.click() })
    expect(requests).toEqual([{ accountId: 'account-a', body: { autoAssign: false } }])
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('閲覧のみでは保存を送らず、現在の設定は読める', async () => {
    const requests = installChannels()
    render(React.createElement(ChannelsTabV8, { accountId: 'account-a', canEdit: false }))
    await screen.findByText('オン')
    expect(screen.queryByRole('switch')).toBeNull()
    expect(requests).toEqual([])
  })

  it('保存に失敗したら設定を変えず、失敗を知らせて再操作を許す', async () => {
    const requests = installChannels(503)
    render(React.createElement(ChannelsTabV8, { accountId: 'account-a', canEdit: true }))
    const toggle = await screen.findByRole('switch')
    await act(async () => { toggle.click() })
    expect(requests).toHaveLength(1)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(toggle.closest('fieldset')?.disabled).toBe(false)
  })
})

describe('画面確認の固定メニューは本番と同じ器を持つ', () => {
  it('一覧の全件が価格種別・版・実効ルールを持つ', async () => {
    const fixturesPath = join(process.cwd(), '..', '..', 'scripts', 'visual-qa', 'fixtures.mjs')
    const fixtures = (await import(pathToFileURL(fixturesPath).href)) as {
      BOOKING_MENUS: Array<Record<string, unknown>>
      BOOKING_SETTINGS: { menuCount: number }
    }
    expect(fixtures.BOOKING_MENUS).toHaveLength(fixtures.BOOKING_SETTINGS.menuCount)
    for (const menu of fixtures.BOOKING_MENUS) {
      expect(['fixed', 'free', 'inquiry']).toContain(menu.price_mode)
      expect(menu.price_mode === 'free' ? menu.base_price === 0 : menu.base_price !== 0).toBe(true)
      expect(Number.isInteger(menu.version) && (menu.version as number) >= 1).toBe(true)
      expect(Array.isArray(menu.assigned_staff)).toBe(true)
      expect(typeof menu.booking_count_30_days).toBe('number')
      const rules = menu.effectiveBookingRules as Record<string, unknown>
      const source = rules.source as Record<string, unknown>
      for (const key of ['bookingWindowDays', 'cutoffMinutesBefore', 'cancelDeadlineMinutesBefore']) {
        expect(typeof rules[key]).toBe('number')
        expect(['store', 'menu']).toContain(source[key])
      }
    }
  })
})
