/*
 * `qlVLJ`（17-1-B マイルの使い道）の禁止の見張り。
 *
 * この面の数字は、**運用者が「誰に声をかけるか」を決めるために見る**。
 * 取れていない数を 0 と書くと、声をかける相手を取り違える。
 * ここに残すのは「書いてはいけない形」だけ。動き（未取得と 0 の区別・
 * 店ごとの読み込み・届かなかった交換のやり直し）は次の描画試験が守る。
 *   - mileage-rewards-tab-react.test.tsx
 *   - mileage-rewards-fidelity-react.test.tsx
 *   - mileage-retry-react.test.tsx
 */

import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TAB = readFileSync(join(__dirname, '../../v8/mileage/rewards.tsx'), 'utf8')

/** 説明の文は「そう書いてある」だけで当たってしまうので、判定の前に落とす。 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('マイルの使い道で書いてはいけない形', () => {
  const code = withoutComments(TAB)



  it('2つの取得で1つの札を使い回さない', () => {
    // 開いた瞬間に後の取得が先を古くし、一覧が loading のまま残る。
    expect(code).not.toMatch(/requestGuard\.issue\(\)/)
  })

  it('読み切っていない交換を「すべて」と言わない', () => {
    // 最後まで読んでいないのに「すべて」と言わない（R365）。
    expect(code).not.toMatch(/failedRedemptions\.length\}つをすべて表示/)
  })
})
