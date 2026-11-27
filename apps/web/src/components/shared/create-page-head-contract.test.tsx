import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import CreatePage from './create-page'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(HERE, 'create-page.tsx'), 'utf8')
const paint = () => renderToStaticMarkup(<CreatePage title="試しの作成" parent={['一覧', '/items']} onSave={async () => {}}><p>中身</p></CreatePage>)

describe('保存の共通処理はV8の作成型を使う', () => {
  it('題と本文は作成型が持つ', () => {
    expect(paint()).toContain('data-page-template="create"')
    expect(paint()).toContain('data-template-region="heading"')
    expect(paint()).toContain('中身')
  })
  it('キャンセルの行き先を残す', () => {
    expect(paint()).toContain('href="/items"')
    expect(paint()).toContain('キャンセル')
  })
  it('作成型を使い、頭の寸法を上書きしない', () => {
    expect(source).toContain('<CreateTemplate')
    expect(source).not.toContain('styles.head')
    expect(source).not.toContain('data-design="Head"')
  })
  it('入力と右欄の配置は作成型へ渡す', () => {
    expect(source).toContain('hidePreviewWhenNarrow')
    expect(source).not.toContain('xl:w-[390px]')
  })
  it('戻る行を本文へ重ねず、下の帯に保存を置く', () => {
    expect(paint()).not.toContain('data-design="Crumb"')
    expect(paint()).toContain('data-template-region="footer"')
    expect(paint()).toContain('保存する')
  })
  it('旧版の寸法選択を持たない', () => {
    expect(source).not.toContain('VariantContext')
    expect(source).not.toContain('CreatePageVariant')
    expect(paint()).not.toContain('data-create-variant')
  })
})
