/*
 * #673（点検 #617 N-033）の再発防止の契約テスト（受け側）。
 *
 * これは**書き方の見張り**で、動きの証拠ではない。実際の動きは
 *   - inbox-673-behavior.spec.mjs（Chromiumで描画して操作する）
 *   - inbox-673-account-boundary.test.ts（apps/worker の本物のルート）
 * が受け持つ。ここは、後から手を入れたときに約束の骨組みが黙って
 * 消えていないかだけを見る。
 *
 * 受信箱は `?friend=` を読むが、送り側が `?friendId=` で渡していた
 * ため対象が引き継がれなかった。受け側の約束をここで固定する。
 * 正常: URLの対象を選び、再読込・共有URL・戻るでも維持する。
 * 不正: 口へ渡さず別人も開かず、案内を出す。
 * 別物: 存在しない・別アカウント・選択中と違うアカウントは別人を開かず案内。
 */
import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, 'page.tsx'), 'utf8')

/**
 * `start` から `end` までを切り出す。**印が無ければ落とす。**
 * 印を消したまま試験が通ると、何も見ていない試験になる。
 */
function region(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  if (from < 0) throw new Error(`区間の始まりが見つかりません: ${start}`)
  const to = source.indexOf(end, from + start.length)
  if (to < 0) throw new Error(`区間の終わりが見つかりません: ${end}`)
  return source.slice(from, to)
}

describe('#673-受け URLから対象者を読み、会話を選ぶ', () => {
  const deepLink = region(PAGE, '// Deep-link from other pages.', 'const clearDeepLink =')

  it('URLに対象が無いときは手選びを消さない', () => {
    expect(deepLink).toContain('if (!rawFriend) return')
  })
})

describe('#673-受け 不正IDは口へ渡さず別人も開かない', () => {
  const deepLink = region(PAGE, '// Deep-link from other pages.', 'const clearDeepLink =')

  it('IDの形を見て、素のまま path へ入らない値を弾く', () => {
    expect(PAGE).toContain('function isSafeFriendIdForInbox(value: string): boolean')
    expect(PAGE).toContain('/^[A-Za-z0-9_-]+$/')
    expect(deepLink).toContain('isSafeFriendIdForInbox(rawFriend)')
  })

  it('不正IDでは選択を作らず、案内だけ出す', () => {
    const invalid = region(deepLink, 'if (!isSafeFriendIdForInbox(rawFriend))', 'return\n    }')
    expect(invalid).toContain('setSelectedChatId(null)')
    expect(invalid).toContain('setDeepLinkNotice(')
    expect(invalid).not.toContain('loadChatDetail')
    expect(invalid).not.toContain('api.chats.get')
  })
})

describe('#673-受け 存在しない・別アカウントは案内の空状態にする', () => {
  const loader = region(PAGE, 'const res = await api.chats.get(chatId, { limit: CHAT_MESSAGE_PAGE_SIZE })', '} finally {')

  it('URL指定の読み込み失敗では別人を開かず案内を出す', () => {
    expect(loader).toContain('deepLinkIdRef.current === chatId')
    expect(loader).toContain('setDeepLinkNotice(')
    // 落ちても他の会話へは倒さない。先頭行の自動選択は無い。
    expect(PAGE).not.toContain('setSelectedChatId(chats[0]')
    expect(PAGE).not.toContain('setSelectedChatId(prev')
  })

  it('開けたら案内を消す', () => {
    expect(loader).toContain("if (deepLinkIdRef.current === chatId) setDeepLinkNotice('')")
  })

  it('中央に理由と戻り先を出す空状態がある', () => {
    expect(PAGE).toContain('会話を開けませんでした')
    expect(PAGE).toContain('受信箱の一覧へ戻る')
  })

  it('一覧へ戻るとURLの指定も外し、再読込で復活させない', () => {
    const clearer = region(PAGE, 'const clearDeepLink =', 'return { deepLinkNotice')
    expect(clearer).toContain('router.replace(')
    expect(clearer).toContain('setSelectedChatId(null)')
  })

  it('手選び・メール選びでは古いURL指定と案内を外す', () => {
    const manual = region(PAGE, 'const handleSelectChat = (chatId: string) => {', 'void withRequestTimeout(api.chats.markRead')
    expect(manual).toContain('deepLinkIdRef.current = null')
    expect(manual).toContain("setDeepLinkNotice('')")
  })
})

describe('#673-受け 選択中のLINEアカウントへ固定する', () => {
  const deepLink = region(PAGE, '// Deep-link from other pages.', 'const clearDeepLink =')

  it('遅い照会が新しい選択を上書きしない', () => {
    expect(deepLink).toContain('deepLinkRequestIdRef.current !== requestId')
    const manual = region(PAGE, 'const handleSelectChat = (chatId: string) => {', 'void withRequestTimeout(api.chats.markRead')
    expect(manual).toContain('deepLinkRequestIdRef.current += 1')
  })
})
