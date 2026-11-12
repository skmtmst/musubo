// @vitest-environment happy-dom
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdvancedSearchDialog from './advanced-search-dialog'

/*
 * FRIEND-13: 詳細条件の窓に role=dialog が無く、Escapeで閉じず、
 * フォーカスが背面の起点ボタンに残っていた。共通overlay規約
 * （useOverlayFocus）へ乗せたことを、実際にmountして確かめる。
 *   ・開くと窓の中へフォーカスが入り、背景スクロールが止まる
 *   ・Escapeで閉じて、開く前に押していたボタンへフォーカスが戻る
 *   ・入れ子の「条件を保存」が開いている間は、Escapeは入れ子だけを閉じる
 */

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      friends: {
        ...actual.api.friends,
        list: () => Promise.resolve({ success: true as const, data: { items: [], total: 0 } }),
      },
      friendSavedViews: {
        ...actual.api.friendSavedViews,
        create: () => Promise.resolve({ success: true as const, data: { id: 'view-1' } }),
      },
    },
  }
})

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" data-trigger onClick={() => setOpen(true)}>
        詳細検索
      </button>
      <AdvancedSearchDialog
        open={open}
        accountId={null}
        tags={[]}
        fieldNames={[]}
        marks={[]}
        scenarios={[]}
        onClose={() => setOpen(false)}
        onApply={() => setOpen(false)}
      />
    </div>
  )
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
  document.body.style.overflow = ''
  vi.restoreAllMocks()
})

async function eventually(check: () => void, timeout = 1_500): Promise<void> {
  const started = Date.now()
  while (true) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
  }
}

const keydown = (key: string) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

async function openDialog(): Promise<HTMLElement> {
  await act(async () => {
    root.render(<Harness />)
  })
  const button = host.querySelector<HTMLButtonElement>('[data-trigger]')!
  await act(async () => {
    button.focus()
    button.click()
  })
  await eventually(() => expect(host.querySelector('[role="dialog"]')).toBeTruthy())
  return host.querySelector<HTMLElement>('[role="dialog"]')!
}

describe('FRIEND-13 詳細条件の窓', () => {
  it('dialog の役割と見出しの紐付けを持ち、開くと窓の中へフォーカスが入る', async () => {
    const panel = await openDialog()
    expect(panel.getAttribute('aria-modal')).toBe('true')
    const labelledby = panel.getAttribute('aria-labelledby')
    expect(labelledby).toBeTruthy()
    expect(document.getElementById(labelledby!)?.textContent).toContain('絞り込み条件を設定')
    await eventually(() => {
      expect(panel.contains(document.activeElement)).toBe(true)
    })
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('Escapeで閉じて、開く前の起点ボタンへフォーカスが戻る', async () => {
    await openDialog()
    const button = host.querySelector<HTMLButtonElement>('[data-trigger]')!
    await eventually(() => expect(document.activeElement).not.toBe(button))
    await act(async () => {
      keydown('Escape')
    })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(document.body.style.overflow).toBe('')
  })

  it('入れ子の「条件を保存」が開いている間、Escapeは入れ子だけを閉じる', async () => {
    await openDialog()
    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === '条件を保存する',
    )!
    await act(async () => {
      saveButton.click()
    })
    await eventually(() => {
      expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(2)
    })
    // 1回目のEscape: 入れ子だけが閉じ、外側の窓は残る。
    await act(async () => {
      keydown('Escape')
    })
    await eventually(() => {
      expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    })
    // 2回目のEscape: 外側の窓が閉じる。
    await act(async () => {
      keydown('Escape')
    })
    await eventually(() => {
      expect(host.querySelector('[role="dialog"]')).toBeNull()
    })
  })
})
