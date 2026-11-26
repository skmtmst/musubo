// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import Step2Connect, { type Step2Field } from './step2-connect'

/*
 * ②アカウント接続 Step2「musubo の Webhook URL」の URL の枠。
 * 承認済み v07（LINE新規追加_v07.pen）の `E01lkh`：高さ36・左右12・角10、右に［コピー］。
 *
 * 一度、ここを `contentPadding="var(--tpl-htn-endpoint-pad)"`（中身は `8px 10px`）と
 * 変数1語で渡したために、Card が左右別々の余白だと見抜けず（card.tsx の hasSides）、
 * 共通の下限16と突き合わされて `max(16px, 8px 10px)` になり、CSS として成り立たず
 * 余白が0に落ちた。枠が文字1行ぶんに潰れ、字が枠線に付いた状態で配備された。
 *
 * なので見るのは書き方ではなく、描いた結果の枠そのもの。左右別々の余白として渡せた
 * ときだけ `data-card-spacing-sides` が付く（card.tsx）ので、これが無ければ
 * 同じ潰れ方に戻ったということ。Card 側の決まりは
 * components/shared/card-content-padding.test.tsx が見ている。
 */

const VALUES: Record<Step2Field, string> = {
  channelId: '',
  channelSecret: '',
  providerId: '',
  loginChannelId: '',
  loginChannelSecret: '',
}

afterEach(cleanup)

describe('Messaging API の取得先', () => {
  it('Step 1 は公式アカウントマネージャーを開き、Step 2 でプロバイダーIDをコピーする', () => {
    const view = render(
      <Step2Connect onBackTo={() => {}} touchedFields={{}} onTouchField={() => {}} onValidateField={() => {}} sub={1} badge="Step 1 / 4" values={VALUES} fieldErrors={{}} acks={{}} onUpdate={() => {}} onToggleAck={() => {}} />,
    )
    expect(view.getByRole('link', { name: 'LINE公式アカウントマネージャーを開く' }).getAttribute('href')).toBe('https://manager.line.biz/')
    expect(view.queryByRole('link', { name: 'LINE Developers を開く' })).toBeNull()
    expect(view.queryByLabelText('プロバイダーID')).toBeNull()
    view.rerender(<Step2Connect onBackTo={() => {}} touchedFields={{}} onTouchField={() => {}} onValidateField={() => {}} sub={2} badge="Step 2 / 4" values={VALUES} fieldErrors={{}} acks={{}} onUpdate={() => {}} onToggleAck={() => {}} />)
    expect(view.getByRole('link', { name: 'LINE Developersを開く' }).getAttribute('href')).toBe('https://developers.line.biz/console/')
    expect(view.getByText(/「プロバイダー設定」の「基本情報」にあるプロバイダーIDをコピー/)).toBeTruthy()
    expect(view.getByLabelText('プロバイダーID')).toBeTruthy()
  })
})

/** ②Step3 を描いて、Ds3E2 の中の URL の枠（内側の Card）を取り出す。 */
function urlFrame() {
  const { container } = render(
    <Step2Connect onBackTo={() => {}} touchedFields={{}} onTouchField={() => {}} onValidateField={() => {}} sub={3} badge="Step 3 / 4" values={VALUES} fieldErrors={{}} acks={{}} onUpdate={() => {}} onToggleAck={() => {}} />,
  )
  const box = container.querySelector('[data-design-node="Ds3E2"]')
  expect(box, '承認済み v07 Ds3E2「musubo の Webhook URL」が描かれていない').not.toBeNull()
  const frame = box?.querySelector<HTMLElement>('[data-design-part="card"][data-card-corner="control"]') ?? null
  expect(frame, 'URL の枠（角 control の内側の Card）が描かれていない').not.toBeNull()
  return frame as HTMLElement
}

describe('②Step3 の Webhook URL の枠は承認済み v07 どおり', () => {
  it('Step1のチャネルIDでMessaging API設定を直接開き、IDがないときは誤ったリンクを出さない', () => {
    const view = render(
      <Step2Connect onBackTo={() => {}} touchedFields={{}} onTouchField={() => {}} onValidateField={() => {}} sub={3} badge="Step 3 / 4" values={{ ...VALUES, channelId: ' 2001234567 ' }} fieldErrors={{}} acks={{}} onUpdate={() => {}} onToggleAck={() => {}} />,
    )
    expect(view.getByRole('link', { name: 'LINE Developers を開く' }).getAttribute('href')).toBe('https://developers.line.biz/console/channel/2001234567/messaging-api')
    view.rerender(<Step2Connect onBackTo={() => {}} touchedFields={{}} onTouchField={() => {}} onValidateField={() => {}} sub={3} badge="Step 3 / 4" values={VALUES} fieldErrors={{}} acks={{}} onUpdate={() => {}} onToggleAck={() => {}} />)
    expect(view.queryByRole('link', { name: 'LINE Developers を開く' })).toBeNull()
    expect(view.getByText('チャネルIDがありません。Messaging APIの情報へ戻って入力してください。')).toBeTruthy()
  })

  it('プロバイダーIDがない古い下書きでは、Step4から別チャネルへ飛ばさない', () => {
    const view = render(
      <Step2Connect onBackTo={() => {}} touchedFields={{}} onTouchField={() => {}} onValidateField={() => {}} sub={4} badge="Step 4 / 4" values={VALUES} fieldErrors={{}} acks={{}} onUpdate={() => {}} onToggleAck={() => {}} />,
    )
    expect(view.queryByRole('link', { name: 'LINE Developers のプロバイダーを開く' })).toBeNull()
    expect(view.getByText('プロバイダーIDがありません。プロバイダーIDの確認へ戻って入力してください。')).toBeTruthy()
  })

  it('表示とコピーが同じチャネル専用URLになる', async () => {
    const previousApiUrl = process.env.NEXT_PUBLIC_API_URL
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const copied: string[] = []
    process.env.NEXT_PUBLIC_API_URL = 'https://stg-api.musubo.jp'
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { copied.push(value) } },
    })
    try {
      const view = render(
        <Step2Connect onBackTo={() => {}} touchedFields={{}} onTouchField={() => {}} onValidateField={() => {}} sub={3} badge="Step 3 / 4" values={{ ...VALUES, channelId: '2001234567' }} fieldErrors={{}} acks={{}} onUpdate={() => {}} onToggleAck={() => {}} />,
      )
      const expected = 'https://stg-api.musubo.jp/webhook/2001234567'
      expect(view.container.querySelector('[data-design-node="Ds3E2"]')?.textContent).toContain(expected)
      fireEvent.click(view.getByRole('button', { name: 'Webhook URL をコピー' }))
      await waitFor(() => expect(copied).toEqual([expected]))
    } finally {
      if (previousApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL
      else process.env.NEXT_PUBLIC_API_URL = previousApiUrl
      if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('左右別々の余白として渡せている（潰れて 0 に落ちない）', () => {
    // これが無いと共通の下限16の規則に当たり、max に2値が入って padding が 0 になる。
    expect(urlFrame().hasAttribute('data-card-spacing-sides')).toBe(true)
  })

  it('承認済み v07 の左右12・上下8を渡している', () => {
    const style = urlFrame().getAttribute('style') ?? ''
    const padding = /--card-content-padding:\s*([^;]+)/.exec(style)?.[1]?.trim()
    expect(padding).toBe('var(--space-8) var(--space-12)')
  })

  it('細い線・角は control（10px）', () => {
    const frame = urlFrame()
    expect(frame.getAttribute('data-card-surface')).toBe('bordered')
    expect(frame.getAttribute('data-card-corner')).toBe('control')
  })

  it('枠のすぐ右に［コピー］が並ぶ', () => {
    const frame = urlFrame()
    const row = frame.parentElement as HTMLElement
    const copy = row.querySelector('[aria-label="Webhook URL をコピー"]')
    expect(copy, '［コピー］が URL の枠と同じ行にない').not.toBeNull()
    // 枠 → ［コピー］の順（左に枠、右にコピー）。
    expect(frame.compareDocumentPosition(copy as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0)
  })
})
