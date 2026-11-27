// @vitest-environment happy-dom
import React, { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { automations: { audiencePreview: net.preview } } }))
const { useAutomationAudience } = await import('./use-automation-audience')
afterEach(() => { cleanup(); vi.clearAllMocks() })
function Subject() {
  const [account, setAccount] = useState('a')
  const selected = useRef<string | null>(account); selected.current = account
  const stash = useRef({})
  const [count, setCount] = useState<number | null>(null)
  const [total, setTotal] = useState<{ accountId: string; draftId: string; total: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const { refreshAudiencePreview } = useAutomationAudience({ formStashRef: stash as never, selectedAccountRef: selected, setPreviewRefreshing: setLoading, setPreviewFailed: setFailed, setPreviewCount: setCount, setPreviewTotal: setTotal, saveErrors: { capture: () => false } as never })
  return <><button onClick={() => void refreshAudiencePreview(account, { id: 'draft', draftVersionId: 'old' })}>前の条件で数える</button><button onClick={() => void refreshAudiencePreview(account, { id: 'draft', draftVersionId: 'new' })}>新しい条件で数える</button><button onClick={() => setAccount('b')}>店を切り替える</button><p>対象 {count ?? '不明'} 人</p><p>全体 {total?.accountId === account ? total.total : '不明'} 人</p>{loading && <p>数えています</p>}{failed && <p>数えられませんでした</p>}</>
}
function deferred() { let resolve!: (value: unknown) => void; let reject!: (reason: unknown) => void; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
it('新しい条件の人数を出したあと、古い結果で上書きしない', async () => {
 const old = deferred(), current = deferred(); net.preview.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
 render(<Subject />); fireEvent.click(screen.getByRole('button', { name: '前の条件で数える' })); fireEvent.click(screen.getByRole('button', { name: '新しい条件で数える' }))
 await act(async () => current.resolve({ success: true, data: { matched: 20, total: 200 } }))
 await act(async () => old.resolve({ success: true, data: { matched: 3, total: 30 } }))
 expect(screen.getByText('対象 20 人')).toBeTruthy(); expect(screen.getByText('全体 200 人')).toBeTruthy()
})
it('店を切り替えたあと、前の店の遅い結果で新しい店の全体人数を消さない', async () => {
 const old = deferred(), current = deferred(); net.preview.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
 render(<Subject />); fireEvent.click(screen.getByRole('button', { name: '前の条件で数える' })); fireEvent.click(screen.getByRole('button', { name: '店を切り替える' })); fireEvent.click(screen.getByRole('button', { name: '新しい条件で数える' }))
 await act(async () => current.resolve({ success: true, data: { matched: 20, total: 200 } }))
 await act(async () => old.resolve({ success: true, data: { matched: 3, total: 30 } }))
 expect(screen.getByText('対象 20 人')).toBeTruthy(); expect(screen.getByText('全体 200 人')).toBeTruthy()
})
it('新しい人数を表示したあと、古い読み込みの失敗を表示しない', async () => {
 const old = deferred(), current = deferred(); net.preview.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
 render(<Subject />); fireEvent.click(screen.getByRole('button', { name: '前の条件で数える' })); fireEvent.click(screen.getByRole('button', { name: '新しい条件で数える' }))
 await act(async () => current.resolve({ success: true, data: { matched: 20, total: 200 } }))
 await act(async () => old.reject(new Error('failed')))
 expect(screen.getByText('対象 20 人')).toBeTruthy(); expect(screen.queryByText('数えられませんでした')).toBeNull()
})
it('古い読み込みが終わっても新しい読み込み中の表示を消さない', async () => {
 const old = deferred(), current = deferred(); net.preview.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
 render(<Subject />); fireEvent.click(screen.getByRole('button', { name: '前の条件で数える' })); fireEvent.click(screen.getByRole('button', { name: '新しい条件で数える' }))
 await act(async () => old.resolve({ success: true, data: { matched: 3, total: 30 } }))
 expect(screen.getByText('数えています')).toBeTruthy()
 await act(async () => current.resolve({ success: true, data: { matched: 20, total: 200 } }))
 expect(screen.queryByText('数えています')).toBeNull()
})
