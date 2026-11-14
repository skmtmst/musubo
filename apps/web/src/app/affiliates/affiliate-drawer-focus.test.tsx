// @vitest-environment happy-dom
/*
 * 成果の詳細の引き出しは共通の焦点管理を使う。開いている間はフォーカスが
 * 内側を循環し、Escapeで閉じて起動ボタンへ戻る。
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { useState } from 'react'

const update = vi.hoisted(() => vi.fn(async () => ({ success: true, data: {} })))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  api: {
    conversionApprovals: { list: async () => ({ success: true, data: { items: [], cursor: null } }) },
    affiliates: {
      update,
      reportV2: async () => ({ success: true, data: null }),
      links: async () => ({ success: true, data: [] }),
      journeys: async () => ({ success: true, data: { items: [], cursor: null } }),
      settlementPreview: async () => ({ success: true, data: { affiliates: [] } }),
    },
  },
}))

vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a {...(p as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}))

const { default: AffiliateDrawerV8 } = await import('@/v8/affiliates/drawer')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/affiliates')
})

const row = {
  id: 'a1',
  name: '山田',
  code: 'YMD-1',
  isActive: true,
} as unknown as Parameters<typeof AffiliateDrawerV8>[0]['affiliate']

function Opener() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        詳細を開く
      </button>
      {open ? (
        <AffiliateDrawerV8
          affiliate={row}
          accountId="acc-1"
          readonly
          startInEdit={false}
          linkBaseUrl="https://example.invalid"
          onClose={() => setOpen(false)}
          onChanged={() => {}}
          onStopRequest={() => {}}
        />
      ) : null}
    </>
  )
}

describe('成果引き出しは共通の窓の動きをする', () => {
  test('報酬率の範囲外は送信せず、0%へ直したら保存できる', async () => {
    update.mockClear()
    render(<AffiliateDrawerV8 affiliate={{ ...row, rewardMode: 'rate', commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={() => {}} onChanged={() => {}} onStopRequest={() => {}} />)
    const rate = await screen.findByLabelText('報酬の割合（%）')
    fireEvent.change(rate, { target: { value: '101' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取り決めを保存する' })) })
    expect(await screen.findByText('報酬率は0から100の間で入力してください')).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
    fireEvent.change(rate, { target: { value: '0' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取り決めを保存する' })) })
    expect(update).toHaveBeenCalledWith('a1', expect.objectContaining({ commissionRate: 0 }))
    // 開いた時の値を一緒に送り、ほかの人が先に保存していたら Worker が止められるようにする。
    expect(update).toHaveBeenCalledWith('a1', expect.objectContaining({
      expected: { name: '山田', rewardMode: 'rate', commissionRate: 10, isActive: true, email: null, holdDays: null, payoutCycle: null, notifyOnConversion: false },
    }))
  })

  test('名前を直して保存する時も、開いた時の値を一緒に送る', async () => {
    update.mockClear()
    render(<AffiliateDrawerV8 affiliate={{ ...row, rewardMode: 'fixed', commissionRate: 0 }} accountId="acc-1" readonly={false} startInEdit={false} linkBaseUrl="https://example.invalid" onClose={() => {}} onChanged={() => {}} onStopRequest={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '紹介者の名前を直すを変更する' }))
    fireEvent.change(screen.getByRole('textbox', { name: '紹介者の名前を直す' }), { target: { value: '山田商店' } })
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: '紹介者の名前を直す' }), { key: 'Enter' }) })
    expect(update).toHaveBeenCalledWith('a1', { name: '山田商店', expected: expect.objectContaining({ name: '山田', commissionRate: 0, isActive: true }) })
  })

  test('Escapeで閉じる', async () => {
    render(<Opener />)
    fireEvent.click(screen.getByRole('button', { name: '詳細を開く' }))
    await screen.findByRole('dialog')
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('閉じたら起動ボタンへフォーカスが戻る', async () => {
    render(<Opener />)
    const trigger = screen.getByRole('button', { name: '詳細を開く' })
    trigger.focus()
    fireEvent.click(trigger)
    await screen.findByRole('dialog')
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})

describe('支払い条件の未保存', () => {
  test('名前の編集はフォーカスが外れても消えず、ページ移動を確かめる', async () => {
    render(<AffiliateDrawerV8 affiliate={row} accountId="acc-1" readonly={false} startInEdit={false} linkBaseUrl="https://example.invalid" onClose={() => {}} onChanged={() => {}} onStopRequest={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '紹介者の名前を直すを変更する' }))
    const input = screen.getByRole('textbox', { name: '紹介者の名前を直す' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '新しい名前' } })
    fireEvent.blur(input)
    const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
    fireEvent.click(link)
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
    expect((screen.getByRole('textbox', { name: '紹介者の名前を直す' }) as HTMLInputElement).value).toBe('新しい名前')
    link.remove()
  })
  test('名前と支払いを両方編集してタブを移ると、確認一回で両方の変更を破棄する', async () => {
    render(<AffiliateDrawerV8 affiliate={{ ...row, commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={() => {}} onChanged={() => {}} onStopRequest={() => {}} />)
    const email = await screen.findByLabelText('連絡先')
    fireEvent.change(email, { target: { value: 'draft@example.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: '紹介者の名前を直すを変更する' }))
    fireEvent.change(screen.getByRole('textbox', { name: '紹介者の名前を直す' }), { target: { value: '新しい名前' } })
    fireEvent.click(screen.getByRole('tab', { name: '概要' }))
    fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
    expect(screen.getByRole('button', { name: '紹介者の名前を直すを変更する' })).toBeTruthy()
  })
  test('入力後のページ移動を止め、編集を続けると入力を保つ', async () => {
    render(<AffiliateDrawerV8 affiliate={{ ...row, commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={() => {}} onChanged={() => {}} onStopRequest={() => {}} />)
    const email = await screen.findByLabelText('連絡先') as HTMLInputElement
    fireEvent.change(email, { target: { value: 'draft@example.invalid' } })
    const link = document.createElement('a')
    link.href = '/templates'
    document.body.appendChild(link)
    fireEvent.click(link)
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
    expect(email.value).toBe('draft@example.invalid')
    link.remove()
  })

  test('入力後の詳細タブ切替も確認する', async () => {
    render(<AffiliateDrawerV8 affiliate={{ ...row, commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={() => {}} onChanged={() => {}} onStopRequest={() => {}} />)
    const email = await screen.findByLabelText('連絡先') as HTMLInputElement
    fireEvent.change(email, { target: { value: 'draft@example.invalid' } })
    fireEvent.click(screen.getByRole('tab', { name: '概要' }))
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  })

  test('タブ切替を破棄しても引き出しは閉じず、確認を繰り返さない', async () => {
    const close = vi.fn()
    render(<AffiliateDrawerV8 affiliate={{ ...row, commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={close} onChanged={() => {}} onStopRequest={() => {}} />)
    const email = await screen.findByLabelText('連絡先')
    fireEvent.change(email, { target: { value: 'draft@example.invalid' } })
    fireEvent.click(screen.getByRole('tab', { name: '概要' }))
    fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
    expect(close).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
  })

  test('引き出しを閉じる確認は一回で編集へ戻れる', async () => {
    const close = vi.fn()
    render(<AffiliateDrawerV8 affiliate={{ ...row, commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={close} onChanged={() => {}} onStopRequest={() => {}} />)
    const email = await screen.findByLabelText('連絡先') as HTMLInputElement
    fireEvent.change(email, { target: { value: 'draft@example.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(await screen.findByRole('dialog', { name: '入力を破棄しますか？' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
    expect(email.value).toBe('draft@example.invalid')
    expect(close).not.toHaveBeenCalled()
  })

  test('入力を戻せばページ移動を止めない', async () => {
    render(<AffiliateDrawerV8 affiliate={{ ...row, commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={() => {}} onChanged={() => {}} onStopRequest={() => {}} />)
    const email = await screen.findByLabelText('連絡先') as HTMLInputElement
    fireEvent.change(email, { target: { value: 'draft@example.invalid' } })
    fireEvent.change(email, { target: { value: '' } })
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })


  test('ページ移動で破棄を選ぶと引き出しを閉じる', async () => {
    const close = vi.fn()
    render(<AffiliateDrawerV8 affiliate={{ ...row, commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={close} onChanged={() => {}} onStopRequest={() => {}} />)
    const email = await screen.findByLabelText('連絡先')
    fireEvent.change(email, { target: { value: 'draft@example.invalid' } })
    const link = document.createElement('a')
    link.href = '/templates'
    document.body.appendChild(link)
    fireEvent.click(link)
    fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
    expect(close).toHaveBeenCalledTimes(1)
    link.remove()
  })

  test('保存中は入力とブラウザの戻るを止める', async () => {
    update.mockImplementationOnce(() => new Promise(() => {}))
    render(<AffiliateDrawerV8 affiliate={{ ...row, commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={() => {}} onChanged={() => {}} onStopRequest={() => {}} />)
    const email = await screen.findByLabelText('連絡先')
    fireEvent.change(email, { target: { value: 'draft@example.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: '取り決めを保存する' }))
    expect(email.closest('form')?.hasAttribute('inert')).toBe(true)
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    fireEvent.popState(window)
    expect(go).toHaveBeenCalledWith(1)
    go.mockRestore()
  })


  test('戻るでタブが先に変わっても入力を保持して確認する', async () => {
    render(<AffiliateDrawerV8 affiliate={{ ...row, commissionRate: 10 }} accountId="acc-1" readonly={false} startInEdit linkBaseUrl="https://example.invalid" onClose={() => {}} onChanged={() => {}} onStopRequest={() => {}} />)
    const email = await screen.findByLabelText('連絡先') as HTMLInputElement
    fireEvent.change(email, { target: { value: 'draft@example.invalid' } })
    window.history.replaceState(null, '', '/affiliates?tab=affiliates/summary')
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    fireEvent.popState(window)
    expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    expect(go).toHaveBeenCalledWith(1)
    expect(email.isConnected).toBe(true)
    expect(email.value).toBe('draft@example.invalid')
    go.mockRestore()
  })

})
