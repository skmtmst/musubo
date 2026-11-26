// @vitest-environment happy-dom
/*
 * 差し込みを札で見せる本文の欄（絵 OVCot ①）の動き。
 * 保存の値は今までどおり {{name}} などの文字・札は Backspace 1回で消える・
 * 変換中の Enter は改行にしない・貼り付けた {{name}} は札になる・上限で切る・互換経路は今の textarea。
 */
import React, { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import InsertTextField, { InsertButton, InsertText, type InsertTextFieldHandle } from './insert-text-field'
import { insertDisplayText, insertTokenTraits, referenceTokenNames, resolveDefaultToken, splitInsertTokens } from './insert-tokens'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let saved: string[] = []

function Harness({ initial = '', maxLength }: { initial?: string; maxLength?: number }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<InsertTextFieldHandle | HTMLTextAreaElement | null>(null)
  /* 差し込むボタン：今の画面と同じく、カーソルの位置へ文字を入れる。 */
  const insert = (token: string) => {
    const element = ref.current
    const start = element?.selectionStart ?? value.length
    const end = element?.selectionEnd ?? start
    const next = value.slice(0, start) + token + value.slice(end)
    setValue(next)
    saved.push(next)
  }
  return (
    <>
      <InsertTextField
        ref={ref}
        aria-label="本文"
        value={value}
        maxLength={maxLength}
        onValueChange={(next) => { setValue(next); saved.push(next) }}
      />
      <InsertButton label="名前" onClick={() => insert('{{name}}')} />
      <output data-testid="value">{value}</output>
    </>
  )
}

const box = () => host.querySelector('[aria-label="本文"]') as HTMLElement
const current = () => (host.querySelector('[data-testid="value"]') as HTMLElement).textContent
const chips = () => Array.from(box().querySelectorAll('[data-token]')).map((chip) => chip.getAttribute('data-token'))

/** カーソルを、本文の箱の子の位置へ置く。 */
function caretAt(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

async function mount(element: React.ReactElement) {
  await act(async () => { root.render(element) })
}

beforeEach(() => {
  saved = []
  document.documentElement.setAttribute('data-theme', 'v8')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
})

describe('札に分ける（保存の文字は1文字も変えない）', () => {
  it('分かる差し込みだけ札にし、分からない {{…}} は文字のまま残す', () => {
    const pieces = splitInsertTokens('{{name}}さん、{{date:ymd}} {{unknown}} {{field.pet_name}}')
    expect(pieces.map((piece) => (piece.kind === 'chip' ? `[${piece.spec.label}]` : piece.text)).join('')).toBe('[名前]さん、[配信日] {{unknown}} [友だち情報]')
    expect(pieces.map((piece) => (piece.kind === 'chip' ? piece.spec.token : piece.text)).join('')).toBe('{{name}}さん、{{date:ymd}} {{unknown}} {{field.pet_name}}')
  })

  it('画面ごとの差し込み（統括の {店名}）は渡したものが札になる', () => {
    const pieces = splitInsertTokens('{店名}より', [{ token: '{店名}', label: '店名', hint: '送る店の名前', icon: 'store' }])
    expect(pieces[0]).toMatchObject({ kind: 'chip', spec: { label: '店名' } })
  })
})

describe('本文の欄（v8）', () => {
  it('{{name}} は緑の札（名前）で見せ、乗せると説明が出る。保存の値は {{name}} のまま', async () => {
    await mount(<Harness initial="{{name}}さん、こんにちは。{{nope}}" />)
    expect(box().getAttribute('role')).toBe('textbox')
    expect(chips()).toEqual(['{{name}}'])
    const chip = box().querySelector('[data-token]') as HTMLElement
    expect(chip.textContent).toBe('名前')
    expect(chip.getAttribute('title')).toBe('受け取る人の名前に置き換わります')
    expect(chip.getAttribute('contenteditable')).toBe('false')
    expect(box().textContent).toContain('{{nope}}')
    expect((box() as unknown as { value: string }).value).toBe('{{name}}さん、こんにちは。{{nope}}')
  })

  it('差し込むボタンで札を入れると、保存の値は {{name}}（カーソルの位置に入る）', async () => {
    await mount(<Harness initial="さん" />)
    act(() => { box().focus() })
    caretAt(box().firstChild!, 0)
    await act(async () => { fireEvent.click(host.querySelector('button')!) })
    expect(current()).toBe('{{name}}さん')
    expect(saved.at(-1)).toBe('{{name}}さん')
    expect(chips()).toEqual(['{{name}}'])
  })

  it('札のすぐ後ろで Backspace を1回押すと札ごと消える', async () => {
    await mount(<Harness initial="{{name}}さん" />)
    act(() => { box().focus() })
    const chip = box().querySelector('[data-token]')!
    caretAt(box(), Array.prototype.indexOf.call(box().childNodes, chip) + 1)
    await act(async () => { fireEvent.keyDown(box(), { key: 'Backspace' }) })
    expect(current()).toBe('さん')
    expect(chips()).toEqual([])
  })

  it('札のすぐ前で Delete を1回押すと札ごと消える', async () => {
    await mount(<Harness initial="こんにちは{{name}}" />)
    act(() => { box().focus() })
    caretAt(box().firstChild!, 5)
    await act(async () => { fireEvent.keyDown(box(), { key: 'Delete' }) })
    expect(current()).toBe('こんにちは')
  })

  it('変換中（IME）の Enter は改行にしない。変換していない Enter は改行', async () => {
    await mount(<Harness initial="あいう" />)
    act(() => { box().focus() })
    caretAt(box().firstChild!, 3)
    await act(async () => { fireEvent.compositionStart(box()) })
    const composing = fireEvent.keyDown(box(), { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(composing).toBe(true)
    await act(async () => { fireEvent.compositionEnd(box()) })
    expect(current()).toBe('あいう')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(current()).toBe('あいう\n')
  })

  it('貼り付けた {{name}} は札になり、保存の値は貼った文字のまま', async () => {
    await mount(<Harness initial="" />)
    act(() => { box().focus() })
    caretAt(box(), 0)
    const clipboardData = { getData: (type: string) => (type === 'text/plain' ? '{{name}}様\r\nありがとう' : '') }
    await act(async () => { fireEvent.paste(box(), { clipboardData }) })
    expect(current()).toBe('{{name}}様\nありがとう')
    expect(chips()).toEqual(['{{name}}'])
  })

  it('文字数の上限を超える貼り付けは、上限で切る（数え方は保存の文字のまま）', async () => {
    await mount(<Harness initial="12345" maxLength={8} />)
    act(() => { box().focus() })
    caretAt(box().firstChild!, 5)
    const clipboardData = { getData: () => 'abcdef' }
    await act(async () => { fireEvent.paste(box(), { clipboardData }) })
    expect(current()).toBe('12345abc')
  })

  it('試験・自動操作が textarea と同じ書き方（value を入れて change）で書ける', async () => {
    await mount(<Harness initial="" />)
    await act(async () => { fireEvent.change(box(), { target: { value: '{{name}}さん' } }) })
    expect(current()).toBe('{{name}}さん')
    expect(chips()).toEqual(['{{name}}'])
  })
})

describe('題（label）とのつながり', () => {
  it('<label for> の題で探せて、題を押すと箱に焦点が来る', async () => {
    function Labelled() {
      const [value, setValue] = useState('')
      return <><label htmlFor="body-x">本文の題</label><InsertTextField id="body-x" value={value} onValueChange={setValue} /></>
    }
    await mount(<Labelled />)
    const field = host.querySelector('#body-x') as HTMLElement
    expect(field.getAttribute('aria-labelledby')).toBe('body-x-label')
    fireEvent.click(host.querySelector('label')!)
    expect(document.activeElement).toBe(field)
  })
})

describe('旧指定でも現在の差し込み表示', () => {
  it('旧テーマ指定でも札を出し、保存値を保つ', async () => {
    document.documentElement.setAttribute('data-theme', 'v7')
    await mount(<Harness initial="{{name}}さん" />)
    const element = box()
    expect(element.tagName).toBe('DIV')
    expect(chips()).toEqual(['{{name}}'])
    expect((element as HTMLTextAreaElement).value).toBe('{{name}}さん')
    element.textContent = '{{name}}'
    await act(async () => { fireEvent.input(element) })
    expect(current()).toBe('{{name}}')
  })
})


describe('閲覧用の差し込み', () => {
  it('送信対応済みのアカウント名も日本語の札で出し、参照名と保存値を保つ', () => {
    const value = '{{account.name}} {{var.business_hours}} {{var.reservation_url}} {{field.pet_name}}'
    act(() => root.render(<InsertText value={value} tokenNames={{ vars: { business_hours: '営業時間', reservation_url: '予約ページ' }, fields: { pet_name: 'ペットの名前' } }} />))
    expect(host.textContent).toBe('LINE公式アカウント名 営業時間 予約ページ ペットの名前')
    expect([...host.querySelectorAll('[data-token]')].map(node => node.getAttribute('data-token')).join(' ')).toBe(value)
  })
  it('解決済みの値の説明にも内部キーを出さず、表示する値はそのままにする', () => {
    act(() => root.render(<InsertText value="{{field.pet_name}}" resolvedValue="ポチ" tokenNames={{ fields: { pet_name: 'ペットの名前' } }} />))
    const chip = host.querySelector('[data-token]')
    expect(chip?.textContent).toBe('ポチ')
    expect(chip?.getAttribute('title')).toBe('友だち情報「ペットの名前」の値に置き換わります')
    expect(chip?.getAttribute('data-token')).toBe('{{field.pet_name}}')
  })
  it('名前を読み込めない差し込みも英語のキーを本文へ出さず、未知の形はそのまま読む', () => {
    act(() => root.render(<InsertText value="{{field.pet_name}} {{var.opening_note}} {{unknown}}" />))
    expect(host.textContent).toBe('友だち情報 共通情報 {{unknown}}')
    expect(host.querySelector('[data-token="{{field.pet_name}}"]')?.getAttribute('title')).toBe('友だち情報の値に置き換わります')
    expect(host.querySelector('[data-token="{{var.opening_note}}"]')?.getAttribute('title')).toBe('共通情報の値に置き換わります')
  })

  it('名前と分かる差し込みは札、未知の差し込みとHTMLに見える文は文字として読む', () => {
    const value = '<script>alert(1)</script>{{name}}さん {{field.plan}} {{unknown}}'
    act(() => root.render(<InsertText value={value} tokenNames={{ fields: { plan: 'プラン' } }} />))
    expect(host.querySelectorAll('[data-token]')).toHaveLength(2)
    expect(host.textContent).toBe('<script>alert(1)</script>名前さん プラン {{unknown}}')
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('[contenteditable]')).toBeNull()
  })
  it('解決した名前と情報の値を札にし、未解決名とHTMLは文字として保つ', () => {
    act(() => root.render(<InsertText value="{{name}}さん {{field.pet}} {{unknown}}" resolvedValue="<b>利用者</b>さん ポチ {{unknown}}" />))
    expect(host.textContent).toBe('<b>利用者</b>さん ポチ {{unknown}}')
    expect(host.querySelector('[data-token="{{name}}"]')?.textContent).toBe('<b>利用者</b>')
    expect(host.querySelector('[data-token="{{field.pet}}"]')?.textContent).toBe('ポチ')
    expect(host.querySelector('b')).toBeNull()
  })

  it('解決できない名前を値の札にせず、本文を一致させられない場合も口が返した文字を保つ', () => {
    act(() => root.render(<InsertText value="{{name}}さん" resolvedValue="{{name}}さん" />))
    // 値が入らなかった差し込みは、値の札にも生の記号にもせず「入りません」と名前で示す。
    expect(host.textContent).toBe('（入りません：名前）さん')
    expect(host.querySelector('[data-token]')).toBeNull()
    expect(host.querySelector('[data-missing-token="{{name}}"]')?.getAttribute('title')).toBe('「名前」の値が入りません')
    act(() => root.render(<InsertText value="{{name}}さん" resolvedValue="異なる本文" />))
    expect(host.textContent).toBe('異なる本文')
    expect(host.querySelector('[data-token]')).toBeNull()
  })

  it('隣り合う差し込みと空の値でも解決済み本文の文字を増減させない', () => {
    act(() => root.render(<InsertText value="{{name}}{{field.pet}}の件" resolvedValue="利用者ポチの件" />))
    expect(host.textContent).toBe('利用者ポチの件')
    expect(host.querySelector('[data-token]')?.textContent).toBe('利用者ポチ')
    act(() => root.render(<InsertText value="{{name}}さん" resolvedValue="さん" />))
    expect(host.textContent).toBe('さん')
  })

})


describe('共通情報の札の名前（見本の表・名前なし・不明な差し込み）', () => {
  it('登録が無くても見本の差し込みは見本の名前、登録の名前があればそちらが勝つ', () => {
    expect(resolveDefaultToken('{{var.closure_datetime}}')?.label).toBe('休業の日時')
    expect(resolveDefaultToken('{{var.reservation_datetime}}')?.label).toBe('予約の日時')
    expect(resolveDefaultToken('{{var.course_name}}')?.label).toBe('コース名')
    expect(resolveDefaultToken('{{var.guest_count}}')?.label).toBe('人数')
    expect(resolveDefaultToken('{{var.closure_datetime}}', { vars: { closure_datetime: '臨時休業の日時' } })?.label).toBe('臨時休業の日時')
    // 共通情報の印（braces）は名前の出どころに関係なく保つ。
    expect(resolveDefaultToken('{{var.closure_datetime}}')?.icon).toBe('braces')
  })

  it('見本の表の「名前」「店名」は共通情報の名前に使わない', () => {
    expect(resolveDefaultToken('{{var.name}}')?.label).toBe('共通情報')
    expect(resolveDefaultToken('{{var.name}}', { vars: {}, varsComplete: true })?.label).toBe('共通情報（名前なし）')
    expect(resolveDefaultToken('{{name}}')?.label).toBe('名前')
    expect(resolveDefaultToken('{{account.name}}')?.label).toBe('LINE公式アカウント名')
  })

  it('読み終えた一覧に無いキーだけ「共通情報（名前なし）」、読込中は種類の名前のまま', () => {
    expect(resolveDefaultToken('{{var.opening_note}}', { vars: {} })?.label).toBe('共通情報')
    expect(resolveDefaultToken('{{var.opening_note}}', { vars: {}, varsComplete: true })?.label).toBe('共通情報（名前なし）')
    // 組み込みの名前（constructor など）を名前の表から拾わない。
    expect(resolveDefaultToken('{{var.constructor}}', { vars: {}, varsComplete: true })?.label).toBe('共通情報（名前なし）')
  })

  it('不明な差し込みは生の記号を見せない画面だけ札にし、保存の文字は変えない', () => {
    const value = '{{pet_name}}さん {{}} {{name}}'
    expect(splitInsertTokens(value).filter(piece => piece.kind === 'chip')).toHaveLength(1)
    const pieces = splitInsertTokens(value, [], {}, { markUnknown: true })
    expect(pieces.map(piece => piece.kind === 'text' ? piece.text : `[${piece.spec.label}]`).join('')).toBe('[不明な差し込み]さん {{}} [名前]')
    expect(pieces.map(piece => piece.kind === 'text' ? piece.text : piece.spec.token).join('')).toBe(value)
    act(() => root.render(<InsertText value={value} markUnknown />))
    expect(host.querySelector('[data-token="{{pet_name}}"]')?.hasAttribute('data-unknown')).toBe(true)
    expect(host.textContent).not.toContain('pet_name')
  })

  it('停止中・期限切れの共通情報は今は入らないと説明し、一覧の印でも入らない側に数える', () => {
    const names = referenceTokenNames({ friendFields: [], commonVars: [
      { varKey: 'campaign', name: 'キャンペーン', status: 'stopped', value: '春' },
      { varKey: 'hours_note', name: '営業時間の補足', status: 'active', value: '平日のみ' },
    ] })
    expect(resolveDefaultToken('{{var.campaign}}', names)?.hint).toBe('共通情報「キャンペーン」は停止中のため、今は値が入りません')
    expect(resolveDefaultToken('{{var.hours_note}}', names)?.hint).toBe('共通情報「営業時間の補足」の値に置き換わります')
    expect(insertTokenTraits('{{var.campaign}} {{var.hours_note}}', names).unfillable.map(spec => spec.label)).toEqual(['キャンペーン'])
  })

  it('予約の差し込みは「予約の知らせ用」の側に数え、相手しだいなので入らない側に数えない', () => {
    const traits = insertTokenTraits('{{var.reservation_datetime}} {{var.closure_datetime}} {{oops}}', { vars: {}, varsComplete: true })
    expect(traits.reservation).toBe(true)
    expect(traits.unfillable.map(spec => spec.label)).toEqual(['休業の日時', '不明な差し込み'])
    // 名前の一覧を読み込み中は、登録が無いと言い切らない。
    expect(insertTokenTraits('{{var.closure_datetime}}', { vars: {} }).unfillable).toEqual([])
  })
})

describe('相手に合わせた本文（送るとこうなります・一覧の抜粋）', () => {
  it('入った値は札、入らない差し込みは「（入りません：名前）」で、改行を保つ', () => {
    const value = '日時：{{var.reservation_datetime}}\n人数：{{var.guest_count}}名'
    act(() => root.render(<InsertText value={value} resolvedValue={'日時：12月1日 18:00\n人数：{{var.guest_count}}名'} />))
    expect(host.textContent).toBe('日時：12月1日 18:00\n人数：（入りません：人数）名')
    expect(host.querySelector('[data-token="{{var.reservation_datetime}}"]')?.textContent).toBe('12月1日 18:00')
    expect(host.querySelector('[data-missing-token="{{var.guest_count}}"]')).not.toBeNull()
    expect(host.textContent).not.toContain('{{')
  })

  it('隣り合う差し込みの途中が入らなくても、入った値と入らない差し込みを分ける', () => {
    act(() => root.render(<InsertText value="{{name}}{{var.closure_datetime}}の件" resolvedValue="山田{{var.closure_datetime}}の件" />))
    expect(host.querySelector('[data-token="{{name}}"]')?.textContent).toBe('山田')
    expect(host.textContent).toBe('山田（入りません：休業の日時）の件')
  })

  it('本文を一致させられないときも、残った差し込みを記号のまま見せない', () => {
    act(() => root.render(<InsertText value="前の本文 {{var.closure_datetime}}" resolvedValue="書き換えた本文 {{var.closure_datetime}}" markUnknown />))
    expect(host.textContent).toBe('書き換えた本文 （入りません：休業の日時）')
  })

  it('画面ごとの札（extraTokens）は相手に合わせた本文でも使う', () => {
    const extra = [{ token: '{{var.guest_count}}', label: '人数', hint: 'この方の次の予約の人数が入ります', icon: 'braces' as const }]
    act(() => root.render(<InsertText value="{{var.guest_count}}名" resolvedValue="2名" extraTokens={extra} />))
    expect(host.querySelector('[data-token="{{var.guest_count}}"]')?.getAttribute('title')).toBe('この方の次の予約の人数が入ります')
  })

  it('title・読み上げ用の文字にも生の記号を出さない', () => {
    expect(insertDisplayText('{{name}}さん {{var.closure_datetime}} {{pet}}', { markUnknown: true })).toBe('［名前］さん ［休業の日時］ ［不明な差し込み］')
    expect(insertDisplayText('{{name}}さん {{var.closure_datetime}}', { resolvedValue: '山田さん {{var.closure_datetime}}' })).toBe('山田さん （入りません：休業の日時）')
  })
})

describe('札の入る欄の操作（消す・カーソル・コピー・変換）', () => {
  function Editor({ initial, onComposing }: { initial: string; onComposing?: (state: string) => void }) {
    const [value, setValue] = useState(initial)
    const ref = useRef<InsertTextFieldHandle | null>(null)
    return <>
      <InsertTextField ref={ref} aria-label="本文" value={value} markUnknown onValueChange={(next) => { setValue(next); saved.push(next) }}
        onCompositionStart={() => onComposing?.('start')} onCompositionEnd={() => onComposing?.('end')} />
      <button type="button" onClick={() => { (window as unknown as { caret?: number | null }).caret = ref.current?.selectionStart ?? null }}>位置</button>
      <output data-testid="value">{value}</output>
    </>
  }

  it('札の中にカーソルを置こうとしても札の後ろへ出し、保存の文字の位置で数える', async () => {
    await mount(<Editor initial="{{name}}さん" />)
    act(() => { box().focus() })
    const label = box().querySelector('[data-token] span:last-child')!.firstChild!
    caretAt(label, 1)
    await act(async () => { fireEvent.click(host.querySelector('button')!) })
    expect((window as unknown as { caret?: number | null }).caret).toBe('{{name}}'.length)
  })

  it('選んでコピーすると、札は元の {{…}} の文字で出る（不明な差し込みも）', async () => {
    await mount(<Editor initial="{{name}}さん {{pet}}" />)
    act(() => { box().focus() })
    const range = document.createRange()
    range.selectNodeContents(box())
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const copied: Record<string, string> = {}
    fireEvent.copy(box(), { clipboardData: { setData: (type: string, text: string) => { copied[type] = text } } })
    expect(copied['text/plain']).toBe('{{name}}さん {{pet}}')
  })

  it('不明な差し込みの札も Backspace 1回で消え、保存の文字から外れる', async () => {
    await mount(<Editor initial="こんにちは{{pet}}" />)
    act(() => { box().focus() })
    const chip = box().querySelector('[data-token="{{pet}}"]')!
    expect(chip.hasAttribute('data-unknown')).toBe(true)
    caretAt(box(), Array.prototype.indexOf.call(box().childNodes, chip) + 1)
    await act(async () => { fireEvent.keyDown(box(), { key: 'Backspace' }) })
    expect(current()).toBe('こんにちは')
  })

  it('日本語の変換の始まりと終わりを呼ぶ側へ伝える（送るキーの判定に使う）', async () => {
    const states: string[] = []
    await mount(<Editor initial="あ" onComposing={(state) => states.push(state)} />)
    await act(async () => { fireEvent.compositionStart(box()) })
    await act(async () => { fireEvent.compositionEnd(box()) })
    expect(states).toEqual(['start', 'end'])
  })
})

describe('変換中に札の名前が届いたとき', () => {
  function Named({ names }: { names: { vars?: Record<string, string> } }) {
    const [value, setValue] = useState('{{var.hours_note}}')
    return <><InsertTextField aria-label="本文" value={value} tokenNames={names} onValueChange={(next) => { setValue(next); saved.push(next) }} /><output data-testid="value">{value}</output></>
  }

  it('確定するまで付け直さず、確定した文字を値へ取り込んでから名前を変える', async () => {
    await mount(<Named names={{}} />)
    act(() => { box().focus() })
    caretAt(box(), box().childNodes.length)
    await act(async () => { fireEvent.compositionStart(box()) })
    // 変換中の文字（未確定）が箱に入っている。
    box().appendChild(document.createTextNode('ごあんない'))
    await mount(<Named names={{ vars: { hours_note: '営業時間の補足' } }} />)
    expect(box().textContent).toContain('ごあんない')
    expect(box().querySelector('[data-token]')?.textContent).toBe('共通情報')
    await act(async () => { fireEvent.compositionEnd(box()) })
    expect(current()).toBe('{{var.hours_note}}ごあんない')
    expect(box().textContent).toContain('ごあんない')
    expect(box().querySelector('[data-token]')?.textContent).toBe('営業時間の補足')
  })

  it('変換していないときは、名前が届いたらすぐ付け直す', async () => {
    await mount(<Named names={{}} />)
    await mount(<Named names={{ vars: { hours_note: '営業時間の補足' } }} />)
    expect(box().querySelector('[data-token]')?.textContent).toBe('営業時間の補足')
    expect(current()).toBe('{{var.hours_note}}')
  })
})
