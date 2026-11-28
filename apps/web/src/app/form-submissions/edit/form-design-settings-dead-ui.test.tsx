// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FormDesignSettings from '@/test-utils/form-appearance-harness'

/*
 * #725: デザイン設定の「押しても何も起きない操作面」を残さない。
 *
 * 文字列を読む契約試験では「入力欄が本当に繋がっているか」を確かめられない
 * （`void [...]` で捨てていても props 名はソースに出る）。ここは本物の React
 * でマウントし、実際に文字を打って親へ届くところまで見る。
 */

const router = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useRouter: () => router }))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  router.replace.mockReset()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.documentElement.dataset.theme = ''
  vi.restoreAllMocks()
})

type Handlers = {
  onChange: ReturnType<typeof vi.fn>
  onOgTitleChange: ReturnType<typeof vi.fn>
  onOgDescriptionChange: ReturnType<typeof vi.fn>
  onOgImageUrlChange: ReturnType<typeof vi.fn>
}

async function render(overrides: Partial<{ ogTitle: string; ogDescription: string; ogImageUrl: string }> = {}) {
  const handlers: Handlers = {
    onChange: vi.fn(),
    onOgTitleChange: vi.fn(),
    onOgDescriptionChange: vi.fn(),
    onOgImageUrlChange: vi.fn(),
  }
  await act(async () => {
    root.render(
      <FormDesignSettings
        formId="form-1"
        accountId={null}
        value={undefined}
        ogTitle={overrides.ogTitle ?? ''}
        ogDescription={overrides.ogDescription ?? ''}
        ogImageUrl={overrides.ogImageUrl ?? ''}
        {...handlers}
      />,
    )
  })
  const open = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('リンクの見え方：'))!
  await act(async () => open.click())
  const url = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'URL で入れる')
  if (url) await act(async () => url.click())
  return handlers
}

/** React が握っている value を飛ばして、本物の入力と同じ形で文字を入れる。 */
async function type(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    setter.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const field = (id: string) => document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)
const buttonTexts = () => Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '')

describe('デザイン設定に無反応な操作面を残さない(#725)', () => {
  it('OGPの3欄が窓の中にあり、打った文字が親へ届く', async () => {
    const handlers = await render()

    const title = field('fe-og-title')
    const description = field('fe-og-desc')
    const imageUrl = field('fe-og-image')
    expect(title).toBeTruthy()
    expect(description).toBeTruthy()
    expect(imageUrl).toBeTruthy()

    await type(title!, 'ごはんの相談フォーム')
    await type(description!, '3分で終わります')
    await type(imageUrl!, 'https://example.test/ogp.png')

    expect(handlers.onOgTitleChange).toHaveBeenCalledWith('ごはんの相談フォーム')
    expect(handlers.onOgDescriptionChange).toHaveBeenCalledWith('3分で終わります')
    expect(handlers.onOgImageUrlChange).toHaveBeenCalledWith('https://example.test/ogp.png')
  })

  it('親が持っている値が、開いたときに欄へ出ている', async () => {
    await render({
      ogTitle: '保存済みの見出し',
      ogDescription: '保存済みの説明',
      ogImageUrl: 'https://example.test/saved.png',
    })
    expect(field('fe-og-title')!.value).toBe('保存済みの見出し')
    expect(field('fe-og-desc')!.value).toBe('保存済みの説明')
    expect(document.body.querySelector('img[alt="カードの画像"]')?.getAttribute('src')).toBe('https://example.test/saved.png')
  })

  it('窓の中に「保存する」を置かない（本物の保存は下部の追従帯だけ）', async () => {
    await render()
    expect(buttonTexts()).not.toContain('保存する')
    // 閉じる・元に戻すは残す。どちらも押すと反応がある。
    // UI-25: 「閉じる」は右上の×（aria-label）へ移った。
    expect(document.body.querySelector('button[aria-label="閉じる"]')).toBeTruthy()
    expect(buttonTexts()).toContain('元に戻す')
  })

  it('押しても何も起きないボタンが1つも無い', async () => {
    await render()
    const dead = Array.from(document.body.querySelectorAll('button')).filter((button) => {
      if (button.disabled) return false
      const props = Object.keys(button).find((key) => key.startsWith('__reactProps$'))
      const onClick = props
        ? (button as unknown as Record<string, { onClick?: unknown }>)[props]?.onClick
        : undefined
      return typeof onClick !== 'function'
    })
    expect(dead.map((button) => button.textContent?.trim())).toEqual([])
  })

  it('背景画像は登録メディアへ繋がったので選択欄を戻した（#725 の条件が解消）', async () => {
    await render()
    // 「なし」一択だった頃は欄ごと消していた。選べる中身ができたので戻す。
    expect(host.textContent).toContain('登録メディアから選択する')
    // 選べる中身がある欄は残っている。
    expect(host.querySelector('[aria-label="書体"]')).toBeTruthy()
    expect(host.querySelector('[aria-label="角の丸み"]')).toBeTruthy()
  })

  it('押せないタブを置かない（区分は見出しで並べる）', async () => {
    await render()
    const spans = Array.from(host.querySelectorAll('span')).map((s) => s.textContent?.trim())
    expect(spans).not.toContain('文字と背景')
    expect(spans).not.toContain('CSSで細かく')
    expect(host.textContent).not.toContain('CSSで細かく')
    // 区分そのものは見出しとして残っていて、中身は同時に見える。
    // 「色」の見出しには決まりの「？」が付くため、前方一致で見る。
    const headings = Array.from(host.querySelectorAll('h3')).map((h) => h.textContent?.trim() ?? '')
    expect(headings).toContain('色と文字')
    expect(headings).toContain('背景とリンクの見え方')
  })
})
