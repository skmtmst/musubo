import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const PAGE = fs.readFileSync(path.join(__dirname, '../../v8/automations/list.tsx'), 'utf8')

/** 注意書きの中の `confirm(` に当てないため、コメントを外す。 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * **ファイル全体を `toContain` で見ない。**
 *
 * 別の処理に同じ字があるだけで通ってしまう（実際に一度素通りした）。
 * 見たい関数の本体と確認窓のJSXだけを切り出してから確かめる。
 */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  expect(a, `${from} が見つからない`).toBeGreaterThanOrEqual(0)
  const b = src.indexOf(to, a + from.length)
  expect(b, `${to} が見つからない`).toBeGreaterThan(a)
  return src.slice(a, b)
}

/** `<ConfirmDialog …>…</ConfirmDialog>` を1つずつに切り分け、目印で選ぶ。 */
function dialogWith(src: string, marker: string): string {
  const blocks = src
    .split('<ConfirmDialog')
    .slice(1)
    .map((block) => `<ConfirmDialog${block.slice(0, block.indexOf('</ConfirmDialog>'))}`)
  const found = blocks.filter((block) => block.includes(marker))
  expect(found.length, `${marker} を持つ確認窓がちょうど1つではない`).toBe(1)
  return found[0]
}

describe('オートメーションの確認窓', () => {
  it('ブラウザの confirm を使わない', () => {
    expect(code(PAGE), 'ブラウザのconfirmへ戻っている').not.toMatch(/[^.\w]confirm\(/)
  })

  it('実行の本体が二度押しを止め、返事を確かめ、finally で戻す', () => {
    const body = slice(PAGE, 'const confirmPending = async', '\n  const runSingleTest')
    expect(body, '同期ロックを取らず処理中でも受け付けてしまう').toContain('pendingLockRef.current')
    expect(body, '生のAPIエラーをそのまま出している').not.toContain('setActionError(res.error)')
    expect(body, 'finally で同期ロックを戻していない').toMatch(/finally \{[\s\S]*pendingLockRef\.current === lock[\s\S]*pendingLockRef\.current = null[\s\S]*setWorking\(false\)/)
  })

  it('押した時点のアカウントを窓に固定する', () => {
    expect(PAGE, '切り替わりを見ていない').toContain(
      'pending.accountId !== selectedAccountIdRef.current',
    )
    const dialog = dialogWith(PAGE, 'open={pending !== null && pending.accountId === selectedAccountId}')
    expect(dialog, '切り替わっても実行できてしまう').toContain(
      'onConfirm={pending?.accountId === selectedAccountId ? () => confirmPending() : undefined}',
    )
  })

  it('保管だけを赤にし、稼働の切替は通常の確認にする', () => {
    const dialog = dialogWith(PAGE, 'open={pending !== null && pending.accountId === selectedAccountId}')
    expect(dialog, '処理中を窓へ渡していない').toContain('busy={working}')
  })

  it('何が消え・何が残るかを本文で読ませる', () => {
    const dialog = dialogWith(PAGE, 'open={pending !== null && pending.accountId === selectedAccountId}')
    // 保管の本文は v8/archive-restore.test.tsx が開いた確認窓で読む。
    // 注意書きの中の「0回」を拾わないよう、コメントを外してから見る。
    expect(code(dialog), '取れない数を0回として作っている').not.toContain('0回')
  })
})
