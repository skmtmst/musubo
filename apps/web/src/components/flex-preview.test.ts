import { describe, expect, it } from 'vitest'
import { normalizeFlexContainer, safeFlexAssetUrl } from './flex-preview'

describe('safeFlexAssetUrl', () => {
  it('公開HTTPS画像だけをプレビューへ渡す', () => {
    expect(safeFlexAssetUrl('https://cdn.example.jp/image.png')).toBe('https://cdn.example.jp/image.png')
  })

  it.each([
    'http://cdn.example.jp/image.png',
    'https://localhost/image.png',
    'https://127.0.0.1/image.png',
    'https://192.168.1.2/image.png',
    'https://user:pass@example.com/image.png',
    'javascript:alert(1)',
  ])('内部・非HTTPS URLを画像として開かない: %s', (url) => {
    expect(safeFlexAssetUrl(url)).toBeNull()
  })
})

/*
 * LAY-05(#982): 過去のカードが `{type:'flex', contents:{...}}` の
 * LINEメッセージ形で保存されていて、直下の bubble/carousel しか
 * 処理しない描画に落ちて白い生JSONになっていた。
 */
describe('normalizeFlexContainer', () => {
  const bubble = { type: 'bubble', body: { type: 'box', contents: [{ type: 'text', text: 'こんにちは' }] } }

  it('直接の bubble はそのまま返す', () => {
    expect(normalizeFlexContainer(bubble)).toBe(bubble)
  })

  it('flex メッセージ形は contents の中身を取り出す', () => {
    const wrapped = { type: 'flex', altText: 'お知らせ', contents: bubble }
    expect(normalizeFlexContainer(wrapped)).toBe(bubble)
  })

  it('flex メッセージ形で包まれた carousel も取り出す', () => {
    const carousel = { type: 'carousel', contents: [bubble, bubble] }
    expect(normalizeFlexContainer({ type: 'flex', altText: 'x', contents: carousel })).toBe(carousel)
  })

  it('contents が配列でも先頭の容器を取り出す', () => {
    expect(normalizeFlexContainer({ type: 'flex', contents: [bubble] })).toBe(bubble)
  })

  it.each([
    { type: 'text', text: 'ただの文字' },
    { type: 'flex' },
    null,
    'bubble ではない文字列',
    42,
  ])('bubble / carousel 以外は描画へ回さない: %j', (value) => {
    expect(normalizeFlexContainer(value)).toBeNull()
  })
})
