import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
const read = (name: string) => readFileSync(new URL(`../../v8/webhooks/${name}.tsx`, import.meta.url), 'utf8')
const pages = [read('incoming'), read('outgoing')]
const host = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
describe('現役V8の見本の入口', () => {
  test('別機能の通知画面を埋め込まない', () => { expect(host).not.toContain('NotificationsPage'); expect(host).not.toContain('@/app/notifications') })
})
describe('切替の二度押しと失敗', () => {
  test('同じ行の再押下を送信前に止める', () => { for (const src of pages) expect(src).toMatch(/if \(togglingRef.current.has\(item.id\)\) \{[\s\S]*?return\s*\}/) })
  test('応答に関係なく処理中の印を外す', () => { for (const src of pages) { expect(src).toMatch(/finally[\s\S]*?togglingRef.current.delete\(item.id\)/); expect(src).toContain('setTogglingIds((current) => current.filter') } })
  test('成功時だけ読み直す', () => { for (const src of pages) { expect(src).toContain('if (!isCurrent()) return'); expect(src).toMatch(/if \(!res.success\)[\s\S]*?return[\s\S]*?await reload\(\)/) } })
  test('失敗時は元へ戻し、再試行を案内する', () => { for (const src of pages) { expect(src).toContain('状態は変わっていません'); expect(src).toContain('もう一度お試しください'); expect(src).toContain("actionLabel: 'もう一度'") } })
  test('行ごとの印で他の行を止めない', () => { for (const src of pages) { expect(src).toContain('togglingRef.current.add(item.id)'); expect(src).toContain('togglingRef.current.has(item.id)'); expect(src).toContain('setOptimisticActive(') } })
})
describe('処理中の表示と再押下の説明', () => {
  test('再押下には待っている理由を示す', () => { for (const src of pages) expect(src).toContain('返事が来るまでお待ちください。') })
  test('処理中の印を対象行に結び付ける', () => { for (const src of pages) { expect(src).toContain('togglingIds.includes('); expect(src).toContain('setTogglingIds((current) => [...current, item.id])') } })
  test('送り先の処理中でも同じ切替操作を呼べてガードを検査できる', () => { expect(pages[1]).toContain('void handleToggle(item, item.isActive)'); expect(pages[1]).toContain("toggling ? '切り替え中'") })
  test('受け取り口も処理中の状態を表示する', () => { expect(pages[0]).toContain('togglingIds.includes(selected.id)'); expect(pages[0]).toContain('切り替え中') })
})
