// @vitest-environment happy-dom
/*
 * ★V8 の生成パネル（統括のバナー生成・プロジェクトの中で使う形 v8Layout）。
 * 品質やクレジットは選ばせない。作りたい内容は任意と上限を添え、
 * 参照画像は3枚まで・使い方の説明を選ぶ前から読める・手元の画像は PNG/JPEG/WebP だけ受け付ける。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BANNER_MAX_REFERENCE_IMAGES, BANNER_REFERENCE_MODE_DESCRIPTION, CUSTOM_PROMPT_MAX, EMPTY_GENERATION_INPUT,
  type BannerGenerationInput, type BannerPreset,
} from '@/lib/hq-banners'
import GenerationPanel from './generation-panel'

const presets: BannerPreset[] = [
  { key: 'line_rich_message', group: 'line', label: 'リッチメッセージ', note: '1040×1040', aspectRatio: '1:1', apiSize: '1024x1024', targetWidth: 1040, targetHeight: 1040 },
]

afterEach(cleanup)

function open(value: Partial<BannerGenerationInput> = {}, handlers: { onPickReference?: () => void; onUploadReference?: (file: File) => void } = {}) {
  return render(
    <GenerationPanel
      v8Layout
      presets={presets}
      maxCount={4}
      value={{ ...EMPTY_GENERATION_INPUT, presetKey: 'line_rich_message', ...value }}
      onChange={vi.fn()}
      reference={null}
      referenceImages={[]}
      onPickReference={handlers.onPickReference ?? (() => undefined)}
      onUploadReference={handlers.onUploadReference ?? (() => undefined)}
    />,
  )
}

describe('★V8 の生成パネル', () => {
  it('作りたい内容・テキスト・色・人物・つくる枚数を並べ、品質やクレジットは選ばせない', () => {
    const view = open()
    const text = view.container.textContent ?? ''
    // 見出しは読み上げ用の legend ではなく、目に見える見出しの字で数える。
    const headings = [...view.container.querySelectorAll('*:not(legend)')].filter((node) => node.childElementCount === 0).map((node) => node.textContent?.trim())
    for (const label of ['作りたい内容', '画像に入れるテキスト', '色', '人物', 'つくる枚数']) expect(headings).toContain(label)
    // 大きさは今の値の1行と変える口だけ（選択肢は窓の中）。
    expect(screen.getByRole('button', { name: '大きさを変更する' })).toBeTruthy()
    expect(text).not.toMatch(/品質|クレジット|高精細|quality/i)
    expect(screen.queryByRole('button', { name: /生成する/ })).toBeNull()
  })

  it('作りたい内容は任意と文字数の上限を添え、例を入れる前から見せる', () => {
    open()
    expect(screen.getByText(`任意・${CUSTOM_PROMPT_MAX}文字まで`)).toBeTruthy()
    expect(screen.getByPlaceholderText('例：桜と料理の写真を使った、春らしい案内')).toBeTruthy()
  })

  it('参照画像はライブラリか手元の PNG・JPEG・WebP から選べ、使い方の説明を選ぶ前から読める', () => {
    const onPickReference = vi.fn()
    const onUploadReference = vi.fn()
    open({}, { onPickReference, onUploadReference })
    expect(screen.getByText(`任意・最大 ${BANNER_MAX_REFERENCE_IMAGES} 枚`)).toBeTruthy()
    for (const description of Object.values(BANNER_REFERENCE_MODE_DESCRIPTION)) expect(screen.getByText(description)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ライブラリから選択する' }))
    expect(onPickReference).toHaveBeenCalledTimes(1)
    const file = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(file.getAttribute('accept')).toBe('image/png,image/jpeg,image/webp')
    const picked = new File(['x'], 'logo.png', { type: 'image/png' })
    fireEvent.change(file, { target: { files: [picked] } })
    expect(onUploadReference).toHaveBeenCalledWith(picked)
  })

  it(`参照画像が${BANNER_MAX_REFERENCE_IMAGES}枚そろったら、足す口を閉じて入れ替え方を言う`, () => {
    open({ references: Array.from({ length: BANNER_MAX_REFERENCE_IMAGES }, (_, i) => ({ imageId: `img-${i}`, mode: 'inspire' as const })) })
    expect(screen.queryByRole('button', { name: 'ライブラリから選択する' })).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(screen.getByText(`参照画像は ${BANNER_MAX_REFERENCE_IMAGES} 枚までです。入れ替えるときは、どれかを外してください。`)).toBeTruthy()
  })
})
