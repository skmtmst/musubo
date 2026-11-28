// @vitest-environment happy-dom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import GenerationPanel from './generation-panel'
import {
  EMPTY_GENERATION_INPUT,
  type BannerGenerationInput,
  type BannerPreset,
  type BannerUsage,
} from '@/lib/hq-banners'

/*
 * R120: 生成画像を用途の指定寸法へ整える。生成は3種類の大きさだけなので、
 * 整形そのものは Worker 側（`banner-resize.ts`）で `fit: cover` で行う。
 * 2026-10-06 オーナー指示で「切り抜きの位置」と点線の枠は機能外として画面から外し、
 * 位置は常に中央にした（型と Worker の受け口は残す）。
 */
afterEach(cleanup)

const presets: BannerPreset[] = [
  { key: 'line_rich_menu_small', group: 'line', label: 'リッチメニュー（小）', note: '2500×843。高さが半分のメニュー', aspectRatio: '3:1', apiSize: '1536x1024', targetWidth: 2500, targetHeight: 843 },
  { key: 'sns_story', group: 'sns', label: 'ストーリー', note: '1080×1920（9:16）', aspectRatio: '9:16', apiSize: '1024x1536', targetWidth: 1080, targetHeight: 1920 },
]

function open(presetKey = 'line_rich_menu_small') {
  const onChange = vi.fn()
  render(
    <GenerationPanel
      presets={presets}
      maxCount={4}
      value={{ ...EMPTY_GENERATION_INPUT, presetKey }}
      onChange={onChange}
      reference={null}
      onPickReference={() => undefined}
      onUploadReference={() => undefined}
    />,
  )
  return onChange
}

describe('機能外の表示を出さない（2026-10-06 オーナー指示）', () => {
  it('切り抜きの位置と点線の枠を出さない', () => {
    open()
    expect(screen.queryByText('切り抜きの位置')).toBeNull()
    expect(screen.queryByRole('radio', { name: '中央' })).toBeNull()
    expect(screen.queryByRole('radio', { name: '上' })).toBeNull()
    expect(screen.queryByRole('radio', { name: '下' })).toBeNull()
    expect(screen.queryByText(/生成後にこの範囲で/)).toBeNull()
  })

  it('「バナー」「自由入力」の切替を出さない', () => {
    open()
    expect(screen.queryByRole('radio', { name: 'バナー' })).toBeNull()
    expect(screen.queryByRole('radio', { name: '自由入力' })).toBeNull()
    expect(screen.queryByText('作りたい画像の説明')).toBeNull()
    // 画像に入れるテキストは今までどおり出す
    expect(screen.getByText('画像に入れるテキスト')).toBeTruthy()
  })
})

/*
 * 画像に入れるテキストの行ごとの「強調」。
 * 承認: musubo-design/バナー生成.pen フレーム `g64HOD`・2026-10-06・
 * 利用者回答「この案で承認する」。決まり 1〜4 をここで押さえる。
 *
 * 親が値を持つ部品なので、押した結果を見るには親側も書き換える必要がある。
 * ここでは小さな入れ物（Host）で実際の画面と同じ往復を作る。
 */
function openLines(textLines: string[], emphasisLines: boolean[]) {
  const seen: BannerGenerationInput[] = []
  function Host() {
    const [value, setValue] = useState<BannerGenerationInput>({
      ...EMPTY_GENERATION_INPUT,
      presetKey: 'line_rich_menu_small',
      textLines,
      emphasisLines,
    })
    return (
      <GenerationPanel
        presets={presets}
        maxCount={4}
        value={value}
        onChange={(next) => {
          seen.push(next)
          setValue(next)
        }}
        reference={null}
        onPickReference={() => undefined}
        onUploadReference={() => undefined}
      />
    )
  }
  render(<Host />)
  return seen
}

const emphasisButtons = () => screen.getAllByRole('button', { name: /行目を強調$/ })
const pressed = () => emphasisButtons().map((b) => b.getAttribute('aria-pressed'))

describe('画像に入れるテキストの「強調」（承認 g64HOD・2026-10-06）', () => {
  it('行ごとに「強調」ボタンが出る', () => {
    openLines(['はじめての方へ', '送料無料'], [false, false])
    const buttons = emphasisButtons()
    expect(buttons).toHaveLength(2)
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['1行目を強調', '2行目を強調'])
    // 丸やタグの印は出さず、文字は「強調」だけ
    expect(buttons.map((b) => b.textContent)).toEqual(['強調', '強調'])
    expect(pressed()).toEqual(['false', 'false'])
  })

  it('押すと入り、もう一度押すと外れる（aria-pressed で伝える）', () => {
    const seen = openLines(['はじめての方へ', '送料無料'], [false, false])
    fireEvent.click(emphasisButtons()[1])
    expect(seen.at(-1)?.emphasisLines).toEqual([false, true])
    expect(pressed()).toEqual(['false', 'true'])
    fireEvent.click(emphasisButtons()[1])
    expect(seen.at(-1)?.emphasisLines).toEqual([false, false])
    expect(pressed()).toEqual(['false', 'false'])
  })

  it('何行でも強調できる', () => {
    const seen = openLines(['A', 'B'], [false, false])
    fireEvent.click(emphasisButtons()[0])
    fireEvent.click(emphasisButtons()[1])
    expect(seen.at(-1)?.emphasisLines).toEqual([true, true])
    expect(pressed()).toEqual(['true', 'true'])
  })

  it('行を消しても強調が同じ行に付いてくる', () => {
    const seen = openLines(['A', 'B', 'C'], [false, true, false])
    expect(pressed()).toEqual(['false', 'true', 'false'])
    fireEvent.click(screen.getByRole('button', { name: '1行目を消す' }))
    expect(seen.at(-1)?.textLines).toEqual(['B', 'C'])
    expect(seen.at(-1)?.emphasisLines).toEqual([true, false])
    expect(pressed()).toEqual(['true', 'false'])
  })

  it('行を足しても強調が同じ行に付いてくる（足した行は入っていない）', () => {
    const seen = openLines(['A', 'B'], [true, false])
    fireEvent.click(screen.getByRole('button', { name: /行を足す/ }))
    expect(seen.at(-1)?.textLines).toEqual(['A', 'B', ''])
    expect(seen.at(-1)?.emphasisLines).toEqual([true, false, false])
    expect(pressed()).toEqual(['true', 'false', 'false'])
  })
})

/*
 * 出力サイズ。今の用途と寸法の1行だけ出し、選び直しは窓で開く（X9）。
 */
describe('出力サイズ', () => {
  it('現在の用途と寸法だけを示し、選択肢は閉じておく', () => {
    open()
    expect(screen.getByText(/リッチメニュー（小）.*2500 × 843/)).toBeTruthy()
    expect(screen.queryByRole('radio', { name: /リッチメニュー（小）/ })).toBeNull()
    expect(screen.queryByRole('radio', { name: /ストーリー/ })).toBeNull()
  })

  it('大きさを変えると全用途を選べ、選んだ値を親へ伝える', () => {
    const onChange = open()
    fireEvent.click(screen.getByRole('button', { name: '大きさを変更する' }))
    expect(screen.getByRole('radio', { name: /リッチメニュー（小）/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /ストーリー/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ presetKey: 'sns_story' }))
  })

  it('既存のSNSの用途を開き直しても選択を保つ', () => {
    open('sns_story')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '大きさを変更する' }))
    expect((screen.getByRole('radio', { name: /ストーリー/ }) as HTMLInputElement).checked).toBe(true)
  })
})

describe('作りたい内容はいちばん上に置く（X9）', () => {
  it('作りたい内容・参照画像・今の大きさの順に並ぶ', () => {
    open()
    const first = screen.getByText('作りたい内容')
    const second = screen.getByText('参照画像')
    const third = screen.getByText(/リッチメニュー（小）.*2500 × 843/)
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

/*
 * ★BG-B `KkTNS` / 補足 `pQlYK`: 色は4つの役割で指定する。承認済みデザインの
 * 並び（ベース・メイン・サブ・強調）と言葉をそのまま出していることを押さえる。
 */
describe('カラーの4つの役割（★BG-B KkTNS）', () => {
  it('4つの役割が承認どおりの順で並び、補足の文も出る', () => {
    open()
    expect(screen.getByText('カラー')).toBeTruthy()
    expect(screen.getByText('4つの役割で指定します')).toBeTruthy()
    for (const label of ['ベースカラー', 'メインカラー', 'サブカラー', '強調カラー']) {
      expect(screen.getByRole('button', { name: `${label}（今の色 指定なし）` })).toBeTruthy()
    }
    expect(screen.getByText('色の決め方')).toBeTruthy()
    expect(screen.getByText(/ベースは背景、メインは主役、サブは差し色、強調は特に目立たせたい文字/)).toBeTruthy()
  })

  it('役割ごとに選んだ色が、その役割だけに入る', () => {
    const onChange = open()
    fireEvent.click(screen.getByRole('button', { name: 'サブカラー（今の色 指定なし）' }))
    fireEvent.click(screen.getByRole('option', { name: '#06c755' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ subColor: '#06c755', baseColor: null, mainColor: null, accentColor: null }))
  })
})

/* 板 : 上限のときはパネルに黄色の帯とプランの誘導を出す。空きがあるときは出さない。 */
describe('zOpMG パネル内の上限の帯', () => {
  const limited: BannerUsage = {
    month: { used: 150, limit: 150, remaining: 0 },
    today: { used: 30, limit: 30, remaining: 0 },
    paused: false,
    pausedReason: null,
    blocked: false,
  }

  it('上限のときは帯と「課金プランを見る」が出る', () => {
    render(
      <GenerationPanel
        presets={presets}
        maxCount={4}
        value={{ ...EMPTY_GENERATION_INPUT, presetKey: 'line_rich_menu_small' }}
        onChange={() => undefined}
        reference={null}
        onPickReference={() => undefined}
        onUploadReference={() => undefined}
        usage={limited}
        onReloadUsage={() => undefined}
      />,
    )
    expect(screen.getByText('今月の生成上限に達しました')).toBeTruthy()
    expect(screen.getByRole('link', { name: '課金プランを見る' })).toBeTruthy()
  })

  it('空きがあるときは帯が出ない', () => {
    open()
    expect(screen.queryByText('今月の生成上限に達しました')).toBeNull()
  })

  it('空きがあるときは今月・今日の残りの棒が出る', () => {
    render(
      <GenerationPanel
        presets={presets}
        maxCount={4}
        value={{ ...EMPTY_GENERATION_INPUT, presetKey: 'line_rich_menu_small' }}
        onChange={() => undefined}
        reference={null}
        onPickReference={() => undefined}
        onUploadReference={() => undefined}
        usage={{
          month: { used: 40, limit: 150, remaining: 110 },
          today: { used: 6, limit: 30, remaining: 24 },
          paused: false,
          pausedReason: null,
          blocked: false,
        }}
        onReloadUsage={() => undefined}
      />,
    )
    expect(screen.getByText('残り110/150枚')).toBeTruthy()
    expect(screen.getByText('残り24/30枚')).toBeTruthy()
    expect(screen.queryByText('今月の生成上限に達しました')).toBeNull()
  })
})

/*
 * 承認済み BG-B（`qIp42`）の補足文は「どの欄の下に出るか」まで絵のとおりにする。
 * 文字があるかだけを見ると、別の欄に付いていても気づけない（実際に
 * `swcu2` が「画像に入れるテキスト」に付いていた）。欄ごとに押さえる。
 */
describe('補足文はPencil BG-Bと同じ欄に付く', () => {
  /** Field 部品は <div 欄><div ラベル行><label>…</label></div>{中身}<p 注記> の形。 */
  function fieldTextOf(label: string): string {
    const el = screen.getByText(label)
    const field = el.parentElement?.parentElement
    if (!field) throw new Error(`「${label}」の欄が見つからない`)
    return field.textContent ?? ''
  }

  it('「同じ条件で…」はつくる枚数の下（`swcu2`・`ELZIS`）', () => {
    open()
    expect(fieldTextOf('つくる枚数')).toContain('同じ条件で指定した枚数ぶん作ります（絵柄は毎回少しずつ変わります）')
  })

  it('「同じ条件で…」を画像に入れるテキストには付けない', () => {
    open()
    expect(fieldTextOf('画像に入れるテキスト')).not.toContain('同じ条件で指定した枚数ぶん作ります')
  })

  it('つくる枚数の注記「一度に 4 枚まで」（`KCFAX`）', () => {
    open()
    expect(fieldTextOf('つくる枚数')).toContain('一度に 4 枚まで')
  })

  /** a より b が後ろにあるか。DOM の並び順をそのまま見る。 */
  function isBefore(a: Element, b: Element): boolean {
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
  }

  it('「一度に 4 枚まで」は4択の上（ラベル行・`KCFAX`）', () => {
    open()
    const choices = screen.getByRole('group', { name: '枚数' })
    expect(isBefore(screen.getByText('一度に 4 枚まで'), choices)).toBe(true)
  })

  it('「同じ条件で…」は4択の下（`swcu2`）', () => {
    open()
    const choices = screen.getByRole('group', { name: '枚数' })
    const below = screen.getByText(/^同じ条件で指定した枚数ぶん作ります/)
    expect(isBefore(choices, below)).toBe(true)
  })

  it('画像に入れるテキストの注記（`l5Dsb1`）', () => {
    open()
    expect(fieldTextOf('画像に入れるテキスト')).toContain('1行に1つ・40文字まで／強調したい行は「強調」')
  })

  /*
   * 書き出す大きさ（`GcuH5`）は絵では下部追従バーの中ほどで、パネルの中ではない。
   * パネルだけを出したここには現れないのが正しい。帯に出す側は画面が持つ。
   */
  it('書き出す大きさはパネルに出さない（`GcuH5` は下部追従バー）', () => {
    open()
    expect(screen.queryByText(/で書き出します$/)).toBeNull()
  })
})
