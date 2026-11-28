// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyPanel, saveCarousel, type CarouselSaveOps, type CarouselSaveResult } from './carousel-core'

function SaveHarness({ selectedAccountId, ops }: { selectedAccountId: string | null; ops: CarouselSaveOps }) {
  const [result, setResult] = useState<CarouselSaveResult | null>(null)
  const panel = {
    ...emptyPanel(),
    title: '見本カード',
    text: '本文です',
    actions: [{ label: '詳しく見る', kind: 'action' as const, uri: '', text: '', formId: '', actions: [] }],
  }

  return (
    <div>
      <button
        type="button"
        onClick={async () => {
          setResult(
            await saveCarousel(
              {
                templateId: null,
                selectedAccountId,
                name: 'カルーセル見本',
                panels: [panel],
                folderId: null,
                tapLimitMode: 'none',
                tapLimitText: '',
              },
              ops,
            ),
          )
        }}
      >
        保存する
      </button>
      {result && !result.ok ? (
        <p role="alert" data-created-id={result.createdId ?? ''}>
          {result.error}
        </p>
      ) : null}
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('カルーセル保存のアカウント未選択と不正応答ガード', () => {
  it('新規作成時にアカウント未選択ならAPIを呼ばずに案内エラーを返す', async () => {
    const create = vi.fn()
    const update = vi.fn()

    render(<SaveHarness selectedAccountId={null} ops={{ create, update } as unknown as CarouselSaveOps} />)
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('LINE公式アカウントを選んでください')
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('作成や2段階目更新で空エラーや欠けたdataが返っても落ちずに日本語エラーとcreatedIdを返す', async () => {
    const create = vi.fn().mockResolvedValueOnce({
      success: true,
      data: { id: 'tpl-1', publishedVersion: 1, draftRevision: 1 },
    })
    const update = vi.fn().mockResolvedValueOnce({
      success: false,
      error: '',
    })

    render(<SaveHarness selectedAccountId="acc-1" ops={{ create, update } as unknown as CarouselSaveOps} />)
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('保存できませんでした')
    expect(alert.getAttribute('data-created-id')).toBe('tpl-1')
  })
})
