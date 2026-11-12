import { readUiSource } from '../../../scripts/test-ui-source.mjs'
const fs = { readFileSync: readUiSource }
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const PAGE = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8')

/** 注意書きの中の `confirm(` に当てないため、コメントを外す。 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * **ファイル全体を `toContain` で見ない。**
 * この画面は1行が長いので、なおさら別の処理の字を拾いやすい。
 */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  expect(a, `${from} が見つからない`).toBeGreaterThanOrEqual(0)
  const b = src.indexOf(to, a + from.length)
  expect(b, `${to} が見つからない`).toBeGreaterThan(a)
  return src.slice(a, b)
}

function dialogWith(src: string, marker: string): string {
  const blocks = src
    .split('<ConfirmDialog')
    .slice(1)
    .map((block) => `<ConfirmDialog${block.slice(0, block.indexOf('</ConfirmDialog>'))}`)
  const found = blocks.filter((block) => block.includes(marker))
  expect(found.length, `${marker} を持つ確認窓がちょうど1つではない`).toBe(1)
  return found[0]
}

describe('ログインユーザーの確認窓', () => {
  it('ブラウザの confirm を使わない', () => {
    expect(code(PAGE), 'ブラウザのconfirmへ戻っている').not.toMatch(/[^.\w]confirm\(/)
    expect(PAGE).toContain("import ConfirmDialog from '@/components/shared/confirm-dialog'")
  })

  it('LINE連携の解除が二度押しを止め、返事を確かめ、finally で戻す', () => {
    const body = slice(PAGE, 'const unlinkLine = async', '\n  const toggleActive = async')
    expect(body, '返事を確かめていない').toContain('if (!res.success) throw new Error(res.error)')
    expect(body, '失敗を握りつぶしている').toContain(
      "setUnlinkError('LINE連携を解除できませんでした。状態を読み直してから、もう一度お試しください。')",
    )
    expect(body, '生のAPIエラーをそのまま出している').not.toMatch(/setUnlinkError\(\s*(caught|e|err)\b/)
    expect(body, 'finally で処理中を戻していない').toMatch(/finally \{ setUnlinking\(false\) \}/)
  })

  it('二段階認証の解除が二度押しを止め、返事を確かめ、finally で戻す', () => {
    const body = slice(PAGE, 'const runDisableTwoFactor = async', '\n  const runRemove = async')
    expect(body, '処理中でも受け付けてしまう').toContain('if (!disablingTarget || disablingTwoFactor) return')
    expect(body, '返事を確かめていない').toContain('if (!res.success) throw new Error(res.error)')
    expect(body, '失敗を握りつぶしている').toContain(
      "setDisableError('二段階認証を解除できませんでした。状態を読み直してから、もう一度お試しください。')",
    )
    expect(body, '生のAPIエラーをそのまま出している').not.toMatch(/setDisableError\(\s*(caught|e|err)\b/)
    expect(body, 'finally で処理中を戻していない').toMatch(/finally \{ setDisablingTwoFactor\(false\) \}/)
  })

  it('どちらもあとから戻せるので赤にしない', () => {
    const unlink = dialogWith(PAGE, 'open={unlinkTarget !== null && unlinkTarget.epoch === unlinkScope.current.epoch}')
    const twoFactor = dialogWith(PAGE, 'open={disablingTarget !== null}')
    // 赤は本当に戻せない操作のために空けておく。戻せる操作に付けると赤が効かなくなる。
    expect(unlink, '張り直せる連携解除まで赤になっている').not.toContain('destructive')
    expect(twoFactor, '設定し直せる解除まで赤になっている').not.toContain('destructive')
    expect(unlink, '処理中を窓へ渡していない').toContain('busy={unlinking}')
    expect(unlink, '失敗を窓の中に出していない').toContain('error={unlinkError}')
    expect(twoFactor, '処理中を窓へ渡していない').toContain('busy={disablingTwoFactor}')
    expect(twoFactor, '失敗を窓の中に出していない').toContain('error={disableError}')
  })

  it('何が止まり・何が残り・戻せるかを本文で読ませる', () => {
    const unlink = dialogWith(PAGE, 'open={unlinkTarget !== null && unlinkTarget.epoch === unlinkScope.current.epoch}')
    expect(unlink).toContain('このユーザーへのLINE通知が止まります。')
    expect(unlink).toContain('招待メールからLINE認証をやり直せば、また繋がります。')
    const twoFactor = dialogWith(PAGE, 'open={disablingTarget !== null}')
    expect(twoFactor).toContain('LINEログインだけでログインできるようになります。')
    // 戻し方の文は staff-two-factor-disable-dialog-react.test.tsx が開いた確認窓で読む。
  })
})
