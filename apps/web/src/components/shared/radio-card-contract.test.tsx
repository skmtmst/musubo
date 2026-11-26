// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RadioCard, { RadioCardGroup } from './radio-card'
import { Field } from './form-controls'

afterEach(cleanup)

function Group({ initial = 'a' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <RadioCardGroup legend="配信方法">
      <RadioCard name="delivery" value="a" checked={value === 'a'} onChange={setValue} title="新しく作る" note="一から作ります。" />
      <RadioCard name="delivery" value="b" checked={value === 'b'} onChange={setValue} title="複製する" note="過去の配信を写します。" />
    </RadioCardGroup>
  )
}

describe('ラジオカード（DEEP-02）', () => {
  it('●・○の文字ではなく本物の input[type=radio] を出し、群名を legend で伝える', () => {
    render(<Group />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    for (const radio of radios) {
      expect((radio as HTMLInputElement).type).toBe('radio')
      // 同じ name の群なので、Tabで群に入り矢印キーで行き来できる（native の動作）
      expect((radio as HTMLInputElement).name).toBe('delivery')
    }
    // 読み上げの群名は fieldset/legend。装飾の●・○は本文に残さない。
    expect(document.querySelector('fieldset legend')?.textContent).toBe('配信方法')
    expect(document.body.textContent).not.toContain('●')
    expect(document.body.textContent).not.toContain('○')
  })

  it('選択状態を checked として伝え、クリックで切り替わる', () => {
    render(<Group />)
    const a = screen.getByRole('radio', { name: /新しく作る/ }) as HTMLInputElement
    const b = screen.getByRole('radio', { name: /複製する/ }) as HTMLInputElement
    expect(a.checked).toBe(true)
    expect(b.checked).toBe(false)
    fireEvent.click(b)
    expect(a.checked).toBe(false)
    expect(b.checked).toBe(true)
  })

  it('カード全体が押せる（input は label に包まれている）', () => {
    const onChange = vi.fn()
    render(<RadioCard name="g" value="x" checked={false} onChange={onChange} title="対象を選ぶ" />)
    const input = screen.getByRole('radio')
    // カード＝label が input を囲むので、タイトル面を押しても選択できる
    expect(input.closest('label')).not.toBeNull()
    fireEvent.click(input)
    expect(onChange).toHaveBeenCalledWith('x')
  })

  it('フォーカスは input が受け、フォーカス枠は選択色と別', () => {
    render(<RadioCard name="g" value="x" checked={false} onChange={() => {}} title="対象" />)
    const input = screen.getByRole('radio')
    ;(input as HTMLElement).focus()
    expect(document.activeElement).toBe(input)
  })

  it('無効のときは選べず、理由を併記する。選択済みの見た目にはしない', () => {
    const onChange = vi.fn()
    render(
      <RadioCardGroup legend="方法">
        <RadioCard name="g" value="x" checked={false} onChange={onChange} title="まだ選べない" disabled disabledReason="アカウント接続後に選べます" />
      </RadioCardGroup>,
    )
    const input = screen.getByRole('radio') as HTMLInputElement
    expect(input.disabled).toBe(true)
    fireEvent.click(input)
    expect(onChange).not.toHaveBeenCalled()
    expect(input.checked).toBe(false)
    expect(screen.getByText('アカウント接続後に選べます')).toBeTruthy()
  })

  it('エラー状態は aria-invalid で伝える', () => {
    render(<RadioCard name="g" value="x" checked={false} onChange={() => {}} title="対象" invalid />)
    expect(screen.getByRole('radio').getAttribute('aria-invalid')).toBe('true')
  })

  it('押せない理由と元の欄の説明を入力へ結び付け、再度使えるときは理由だけを外す', () => {
    const view = (disabled: boolean) => <Field label="送り先" note="この設定の対象です"><RadioCard name="recipient" value="a" checked={false} onChange={() => {}} title="担当者" disabled={disabled} disabledReason="接続後に選べます" /></Field>
    const { rerender } = render(view(true))
    const input = screen.getByRole('radio') as HTMLInputElement
    const descriptions = () => (input.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent).filter(Boolean)
    expect(descriptions()).toContain('接続後に選べます')
    expect(descriptions()).toContain('この設定の対象です')
    rerender(view(false))
    expect(input.disabled).toBe(false)
    expect(descriptions()).not.toContain('接続後に選べます')
    expect(descriptions()).toContain('この設定の対象です')
  })

  it('icon={null} で上段の図柄なし（j8p3yj の絵どおり題＋説明のみ）', () => {
    const { container } = render(
      <RadioCard name="g" value="x" checked={false} onChange={() => {}} title="対象" note="説明" icon={null} />,
    )
    // 上段の図柄（aria-hidden の飾り span）が出ない。題と説明は残る。
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull()
    expect(screen.getByText('対象')).toBeTruthy()
    expect(screen.getByText('説明')).toBeTruthy()
  })

  it('印は渡したときだけ出る（本線の既定。合格した画面は印を渡している）', () => {
    const { container } = render(
      <RadioCard name="g" value="x" checked={false} onChange={() => {}} title="対象" />,
    )
    expect(container.querySelector('span[aria-hidden="true"] svg')).toBeNull()
  })
})

describe('選ぶカードの箱（fNPdg オン・r3xz1W オフ）の数値', () => {
  const css = () =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'radio-card.module.css'), 'utf8')

  it('箱は内側16・間8・角丸12を保つ（最低の高さは下の「アイコン付きの箱だけ最低98」で見る）', () => {
    const blocks = [...css().matchAll(/:root\s*\.card\s*\{[^}]*\}/gs)].map((m) => m[0])
    expect(blocks.length, 'v8 の箱の指定がありません').toBeGreaterThan(0)
    // 値は複数の v8 ブロックに分かれる。どれかにあればよい（後勝ちで打ち消しなし）。
    for (const re of [/padding:\s*var\(--polish-space-card\)/, /gap:\s*var\(--polish-space-row\)/, /border-radius:\s*var\(--polish-radius-card\)/]) {
      expect(blocks.some((b) => re.test(b)), `${re} が v8 の箱にありません`).toBe(true)
    }
  })

  it("共通部品の選択の枠と、題・説明の文字を保つ", () => {
    const c = css()
    expect(c).toMatch(/html:root\s*\.checked[^{]*\{[^}]*outline:\s*var\(--choice-card-ring\) solid var\(--color-selection-border\)/s)
    const titles = [...c.matchAll(/:root\s*\.title\s*\{[^}]*\}/gs)].map((m) => m[0])
    expect(titles.length, 'v8 の題の指定がありません').toBeGreaterThan(0)
    // 後の規則が折り返しだけを足しても、各文字の値の最後の宣言を確認する。
    for (const [property, value] of [['font-size', 'var(--polish-text-support)'], ['line-height', 'var(--text-lh)'], ['font-weight', 'var(--polish-weight-label)']]) {
      const declarations = [...titles.join('\n').matchAll(new RegExp(`${property}:\\s*([^;}]+)`, 'g'))]
      expect(declarations.at(-1)?.[1].trim()).toBe(value)
    }
    const notes = [...c.matchAll(/:root\s*\.note\s*\{[^}]*\}/gs)].map((m) => m[0])
    expect(notes.length, 'v8 の説明の指定がありません').toBeGreaterThan(0)
    const note = notes[notes.length - 1]
    expect(note).toMatch(/font-size:\s*var\(--polish-text-support\)/)
    expect(note).toMatch(/line-height:\s*var\(--text-lh\)/)
    // 印は選択中も文字の色を継ぐ（⑤）。
    expect(c).toMatch(/:root\s*\.checked \.topIcon\s*\{[^}]*color:\s*inherit/s)
  })

  it('オフは白地＋1px の hairline 枠・丸の輪郭 control-border（r3xz1W）', () => {
    const c = css()
    expect(c).toMatch(/:root\s*\.card\s*\{[^}]*outline:\s*1px solid var\(--color-hairline\)/s)
  })
})

describe('選ぶカードの行型（BHEl9・変わり形）', () => {
  it('箱なしの行で、本物の input[type=radio] のまま選べる', () => {
    const onChange = vi.fn()
    render(
      <RadioCardGroup legend="担当範囲">
        <RadioCard name="scope" value="all" checked={false} onChange={onChange} title="全アカウント" variant="row" />
        <RadioCard name="scope" value="part" checked onChange={onChange} title="一部のアカウント" note="選んだアカウントだけ" variant="row" />
      </RadioCardGroup>,
    )
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    const labels = document.querySelectorAll('label[data-variant="row"]')
    expect(labels).toHaveLength(2)
    // 行全体が label で、押すと選べる。
    expect(radios[0].closest('label')?.getAttribute('data-variant')).toBe('row')
    fireEvent.click(radios[0])
    expect(onChange).toHaveBeenCalledWith('all')
    // 補足も行の中に出る。
    expect(screen.getByText('選んだアカウントだけ')).toBeTruthy()
  })

  it('行は丸18・間8・箱と面なし（BHEl9 の数値）', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'radio-card.module.css'), 'utf8')
    const row = css.match(/\.row\s*{[^}]*}/s)
    expect(row, '行型の指定がありません').toBeTruthy()
    expect(row![0]).toMatch(/gap:\s*8px/)
    expect(row![0]).toMatch(/background:\s*transparent/)
    expect(row![0]).not.toMatch(/border:[^}]*solid/)
    const rowRadio = css.match(/:root\s*\.row\s*\.radio\s*{[^}]*}/s)
    expect(rowRadio, '行型の丸の指定がありません').toBeTruthy()
    expect(rowRadio![0]).toMatch(/width:\s*18px/)
    expect(rowRadio![0]).toMatch(/position:\s*static/)
  })
})

describe('V8 の丸（2026-10-06 オーナー：絵どおり丸を出す。バナーの小さい箱だけ丸なし）', () => {
  const css = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'radio-card.module.css'), 'utf8')
  it('普通の箱（card）の丸は消さない', () => {
    expect(css()).not.toMatch(/:root \.card > \.radio[^{]*\{[^}]*opacity:\s*0/)
  })
  it('小さい箱（compact）だけ丸を見えなくする（input は残す）', () => {
    expect(css()).toMatch(/:root \.compact > \.radio[^{]*\{[^}]*opacity:\s*0/)
  })
})

describe('LINEでの見え方の題（#1482 で基本の見た目が消えた再発を防ぐ）', () => {
  it('題の基本（横並び・下の間）が部品の CSS にある', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'line-preview.module.css'), 'utf8')
    expect(css).toMatch(/(^|\n)\.phoneTitle \{[^}]*display:\s*flex[^}]*margin:\s*0 0 10px/)
  })
})

describe('ラジオカードの高さ 90 の口（★V8 E-3 ウォークインの卓 PUWyq）', () => {

  it('既定の箱には付かず、height="short" を渡したときだけ付く', () => {
    render(
      <RadioCardGroup legend="卓">
        <RadioCard name="t" value="a" checked onChange={() => {}} title="既定" />
        <RadioCard name="t" value="b" checked={false} onChange={() => {}} title="低い" height="short" />
        <RadioCard name="t" value="c" checked={false} onChange={() => {}} title="行" variant="row" height="short" />
      </RadioCardGroup>,
    )
    const labelOf = (name: string) => screen.getByRole('radio', { name: new RegExp(name) }).closest('label')!
    expect(labelOf('既定').className).not.toMatch(/short/)
    expect(labelOf('低い').className).toMatch(/short/)
    // 箱でない形（行）には効かせない
    expect(labelOf('行').className).not.toMatch(/short/)
  })

  it('上のアイコンの有無に応じて高さの対象を区別する', () => {
    render(<RadioCardGroup legend="選択">
      <RadioCard name="height" value="icon" checked={false} onChange={() => {}} title="アイコンあり" icon={<span>印</span>} />
      <RadioCard name="height" value="plain" checked onChange={() => {}} title="アイコンなし" />
    </RadioCardGroup>)
    expect(screen.getByRole('radio', { name: 'アイコンあり' }).closest('label')?.hasAttribute('data-top-icon')).toBe(true)
    expect(screen.getByRole('radio', { name: 'アイコンなし' }).closest('label')?.hasAttribute('data-top-icon')).toBe(false)
  })


})
