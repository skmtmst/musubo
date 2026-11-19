import { readUiSource as readFileSync } from '../../../../scripts/test-ui-source.mjs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('V8 予約メニューの取得状態', () => {

  it('APIの内部エラーを利用者へそのまま出さない', () => {
    expect(PAGE).toContain("setMenusError(bookingErrorMessage(error, '読み込み'))")
    expect(PAGE).toContain("bookingErrorMessage(cause, '保存')")
    expect(PAGE).not.toContain('setError(e instanceof Error ? e.message')
  })

  it('アカウント切替時に前の件数と割り当てを残さない', () => {
    expect(PAGE).toContain('setStaffMatrices({})')
    expect(PAGE).toContain("setMenusStatus('loading')")
  })

  it('担当と30日件数はメニュー一覧の集計だけを使い、予約明細を運ばない', () => {
    expect(PAGE).toContain('menu.assigned_staff ?? []')
    expect(PAGE).toContain('menu.booking_count_30_days ?? 0')
    expect(PAGE).not.toContain('bookingApi.listMenuStaff')
    expect(PAGE).not.toContain("bookingApi.listRequests(selectedAccountId, 'all')")
  })

  it('切替前のアカウントから遅れて届いた一覧を表示しない', () => {
    expect(PAGE).toContain('const generation = ++generationRef.current')
    expect(PAGE).toContain('if (!alive()) return')
    expect(PAGE).toContain("setMenusStatus('ready')")
  })

  it('作り替えの覚え書きを利用者へ出さない', () => {
    expect(PAGE).not.toContain('旧デザインでは')
  })
})
