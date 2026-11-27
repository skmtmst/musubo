import { readApiSource } from '../../../scripts/test-api-source.mjs'
import { readUiSource } from '../../../scripts/test-ui-source.mjs'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAGE = readUiSource(
  new URL('../../app/line-notifications/page.tsx', import.meta.url),
  'utf8',
)
const LIST = readFileSync(new URL('../../v8/settings/line-notifications/runs-tab.tsx', import.meta.url), 'utf8')
const STATE = readFileSync(new URL('./notification-run-state.ts', import.meta.url), 'utf8')
const API = readApiSource(new URL('../../lib/api.ts', import.meta.url), 'utf8')

describe("管理画面 LINE notification history contract", () => {
  it('keeps the page title in the shared top bar and places history in the tab row', () => {
    expect(PAGE).not.toContain('<Header')
    expect(PAGE).toContain('<Tabs')
    expect(PAGE).toContain("{ key: 'failures', label: '送れなかったもの' }")
    expect(PAGE).toContain("{ key: 'history', label: '記録' }")
  })

  it('requests records only after a LINE account is explicitly selected', () => {
    expect(PAGE).toContain('lineAccountId={selectedAccountId}')
    expect(STATE).toContain('if (!params.lineAccountId)')
    expect(API).toContain("new URLSearchParams({ lineAccountId: params.lineAccountId })")
    expect(STATE.indexOf('++env.requestRef.current')).toBeLessThan(STATE.indexOf('if (!params.lineAccountId)'))
  })

  it('distinguishes loading, empty, failure, and a real zero', () => {
    expect(LIST).toContain('kind="loading"')
    expect(LIST).toContain('kind="empty"')
    expect(LIST).toContain('kind="error"')
    // 板 ：送れなかった件数は口の合計。未取得のとき0にしない。
    expect(LIST).toContain("kpiValue(summary?.failed ?? null)")
    expect(LIST).toContain("items.length === 0")
    expect(LIST).toContain('data-list-state={listState}')
  })

  it('does not claim delivery or individual reads from a LINE API acceptance', () => {
    // 受け付けた行の言い方は v8/settings/line-notifications/runs-tab-accepted.test.tsx が描いて読む。
    expect(LIST).not.toContain('届きました')
    expect(LIST).not.toContain('開きました')
  })

  it('shows retry only when the ledger marks the row retryable and sends its record version', () => {
    expect(STATE).toContain('expectedVersion: item.recordVersion')
    expect(LIST).toContain('送信を再試行')
    expect(API).toContain('retryAvailable: boolean')
    expect(API).toContain('/api/line-notifications/deliveries/${encodeURIComponent(id)}/retry')
    expect(LIST).toContain('受信箱で連絡')
  })

  it('uses ledger attempts while keeping click and definition version nullable', () => {
    expect(API).toContain('attemptCount: number')
    expect(API).toContain('clickedAt: string | null')
    expect(API).toContain('version: number | null')
    expect(API).toContain('recordVersion: number')
  })

  it('advances the account/tab generation synchronously in the render body, not inside a useEffect', () => {
    /*
     * 司令塔差し戻し: 世代の切替をuseEffectで行うと、account切替の
     * レンダーから次のuseEffectが動くまでの窓で、直前のPromiseが
     * マイクロタスクとして先にほどけたとき、isCurrent判定が古い世代の
     * ままになり、notice・retrying・reloadが新しい画面へ漏れる。
     * レンダー本体で同期して進めていることを、構造で固定する。
     */
    const setScopeIndex = LIST.indexOf('setScope({ key: currentScopeKey, generation: scope.generation + 1 })')
    const firstUseEffectIndex = LIST.indexOf('useEffect(')
    expect(setScopeIndex).toBeGreaterThan(-1)
    expect(firstUseEffectIndex).toBeGreaterThan(-1)
    expect(setScopeIndex).toBeLessThan(firstUseEffectIndex)
    // env越しに非同期処理から読める世代のミラーも、useEffectではなくレンダー本体で更新する。
    expect(LIST.indexOf('scopeRef.current = scope')).toBeLessThan(firstUseEffectIndex)
  })
})
