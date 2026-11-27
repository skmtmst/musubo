import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = path.join(__dirname, '..')

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8')
}

function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const MIGRATED = [
  'v8/events/edit-form.tsx',
  'v8/events/create.tsx',
  'components/rich-menus/apply-to-tag-modal.tsx',
]

describe("管理画面 確認窓への移行（4本目）", () => {
  it.each(MIGRATED)('%s は共通の確認窓を使い、ブラウザの確認・警告を残さない', (rel) => {
    const src = withoutComments(read(rel))
    expect(src).toMatch(/from '@\/(?:components\/shared\/confirm-dialog|lib\/unsaved-leave-dialog)'/)
    expect(src).toMatch(/<(?:ConfirmDialog|UnsavedLeaveDialog)\b/)
    expect(src).not.toMatch(
      /(?:(?:window|globalThis|self)\s*\.\s*confirm\s*\()|(?:(?:^|[^.\w])confirm\s*\()/,
    )
    expect(src).not.toMatch(/(?:^|[^.\w])alert\s*\(/)
  })
})

describe('イベント編集の予約枠', () => {
  const src = read('v8/events/edit-form.tsx')

  it('枠の削除は二度押しを止め、失敗を窓に出す', () => {
    expect(src).toContain('async function deleteSlot()')
    expect(src).toContain('if (!deleteSlotTarget || !eventId || deletingSlot) return')
    expect(src).toContain('枠を削除できませんでした。')
    expect(src).toContain('setDeletingSlot(false)')
    expect(src).toContain('title="この予約枠を削除しますか？"')
    expect(src).toContain('いま予約は入っていません')
    expect(src).toContain('busy={deletingSlot}')
    expect(src).toContain('destructive')
  })

  it('まとめて作る前に件数を下見し、0件なら実行させない', () => {
    expect(src).toContain('bulkPreview.slots.length > 0 ?')
    expect(src).toContain('作られる枠が0件です')
    expect(src).toContain('まだ何も作っていません')
    expect(src).toContain('busy={bulkBusy}')
    expect(src).toContain('error={bulkError}')
  })

  it('途中まで作られた可能性を隠さず、一覧を読み直す', () => {
    expect(src).toContain('async function createBulkSlots()')
    expect(src).toContain('if (!bulkPreview || !eventId || bulkBusy) return')
    expect(src).toContain('途中まで作られていることがあります')
    expect(src).toContain('await refresh()')
  })
})

describe('イベント作成の予約枠', () => {
  const src = read('v8/events/edit-form.tsx')
  const create = read('v8/events/create.tsx')

  it('まとめて追加は下見を出してから作る', () => {
    expect(create).toContain('router.replace(`/events/edit?id=${encodeURIComponent(continuingId)}`)')
    // #1000: 下見の時点で操作IDと枠ごとの再送防止キーを確定する。
    expect(src).toContain('setBulkPreview({')
    expect(src).toContain('client_key')
    expect(src).toContain('件の予約枠を作りますか？')
    expect(src).toContain('いまある枠は消えません')
    expect(src).toContain('busy={bulkBusy}')
    expect(src).toContain('error={bulkError}')
  })

  it('作る側は二度押しを止め、途中まで作られた可能性を書く', () => {
    expect(src).toContain('async function createBulkSlots()')
    expect(src).toContain('if (!bulkPreview || !eventId || bulkBusy) return')
    expect(src).toContain('途中まで作られていることがあります')
    expect(src).toContain('await refresh()')
  })

  it('枠の削除は二度押しを止め、失敗を窓に出す', () => {
    expect(src).toContain('async function deleteSlot()')
    expect(src).toContain('if (!deleteSlotTarget || !eventId || deletingSlot) return')
    expect(src).toContain('枠を削除できませんでした。')
    expect(src).toContain('setDeletingSlot(false)')
    expect(src).toContain('title="この予約枠を削除しますか？"')
    expect(src).toContain('いま予約は入っていません')
    expect(src).toContain('busy={deletingSlot}')
  })
})

describe('リッチメニューを全員のデフォルトにする', () => {
  const src = read('components/rich-menus/apply-to-tag-modal.tsx')

  it('二度押しを止め、失敗を窓に出す', () => {
    expect(src).toContain('async function confirmSetDefault()')
    expect(src).toContain('if (defaultBusy) return')
    expect(src).toContain('全員のデフォルトに設定できませんでした。')
    expect(src).toContain('setDefaultBusy(false)')
    expect(src).toContain('busy={defaultBusy}')
    expect(src).toContain('error={defaultError}')
  })

  it('前の既定が記録されないことまで書き、戻せる操作として出す', () => {
    expect(src).toContain('これから友だちになる人にも出ます')
    expect(src).toContain('そちらの設定は外れます')
    expect(src).toContain('前にどのメニューがデフォルトだったかは記録されない')
    expect(src).not.toContain('destructive\n        busy={defaultBusy}')
  })
})
