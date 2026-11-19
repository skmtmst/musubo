import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 受信箱の応答対象照合・会話ごとの下書き・予約の冪等キーの契約試験
 * (#962/#965)。
 *
 * 対象は `apps/web/src/app/chats/page.tsx`。動作の証拠は
 * `inbox-stale-response-react.test.tsx` が本物のReactで通す。ここでは
 * 仕組みが消えないことを縛る。
 */

const PAGE = readFileSync(join(__dirname, 'page.tsx'), 'utf8')
  + readFileSync(new URL('../../v8/inbox-chat/schedule-dialog.tsx', import.meta.url), 'utf8')

describe('受信箱の応答対象照合(#962)', () => {
  it('「前のメッセージ」の応答は要求時の会話・アカウントと一致するときだけ履歴へ足す', () => {
    expect(PAGE).toContain('const requestedChatId = selectedChatId')
    expect(PAGE).toContain('if (selectedChatIdRef.current !== requestedChatId || detailAccountRef.current !== requestedAccountId) return')
    expect(PAGE).toContain('if (!prev || prev.id !== requestedChatId) return prev')
  })

  it('予約一覧の応答は要求時の会話・アカウントと一致するときだけ反映する', () => {
    const loader = PAGE.match(/const loadScheduledSends = useCallback[\s\S]*?\}, \[[^\]]*\]\)/)
    expect(loader).not.toBeNull()
    const body = loader![0]
    expect(body).toContain('const requestedAccountId = detailAccountRef.current')
    expect(body).toContain('selectedChatIdRef.current !== chatId || detailAccountRef.current !== requestedAccountId')
    // 失敗を「予約なし」にしない: catch で一覧を空に戻さない。
    expect(body).not.toContain('setScheduledSends([])')
    expect(body).toContain('setScheduledSendsFailed(true)')
  })

  it('会話切替の時点で前の会話の予約行を残さない', () => {
    const effect = PAGE.match(/useEffect\(\(\) => \{\s+\/\/ 会話を切り替えたら[\s\S]*?\}, \[selectedChatId, loadScheduledSends\]\)/)
    expect(effect).not.toBeNull()
    expect(effect![0]).toContain('setScheduledSends([])')
    expect(effect![0]).toContain('setScheduledSendsFailed(false)')
  })

  it('下書きはアカウント＋会話ごとに預かり、切替で預け・戻しする', () => {
    expect(PAGE).toContain('const messageDraftsRef = useRef(new Map<string, string>())')
    expect(PAGE).toContain('const imageDraftsRef = useRef(new Map<string, ImageUploaderValue>())')
    expect(PAGE).toContain('const draftOwnerKeyRef = useRef(draftKeyOf(selectedAccountId, selectedChatId))')
    expect(PAGE).toContain('setMessageContent(messageDraftsRef.current.get(nextKey) ??')
    // 会話を選ぶ処理で無条件に消さない(預かりへ移した)。
    const selectChat = PAGE.match(/const handleSelectChat = \(chatId: string\) => \{[\s\S]*?\n  \}/)
    expect(selectChat).not.toBeNull()
    expect(selectChat![0]).not.toContain("setMessageContent('')")
    expect(selectChat![0]).not.toContain('setPendingImage(null)')
  })

  it('送信・予約に使った版の下書きだけを預かりから外す', () => {
    expect(PAGE).toContain('const dropSentDraft = (')
    expect(PAGE).toContain('dropSentDraft(sendingChatId, sendingAccountId, { content, image: pendingImage })')
    expect(PAGE).toContain('dropSentDraft(sendingChatId, sendingAccountId, { image: pendingImage })')
    expect(PAGE).toContain('dropSentDraft(sendingChatId, sendingAccountId, { content })')
    expect(PAGE).toContain('dropSentDraft(schedulingChatId, schedulingAccountId, { content })')
    // 入力欄・添付は「今もその会話を開いていて、版が変わっていない」ときだけ消す。
    expect(PAGE).toContain("setMessageContent((prev) => (prev.trim() === content ? '' : prev))")
    // 添付は送った版と同じときだけ外し、ファイル名の記録も一緒に消す(INBOX-23/32)。
    expect(PAGE).toContain('if (pendingImageRef.current === pendingImage)')
  })
})

describe('予約送信の冪等キー(#965)', () => {
  it('同じ送信版には版単位で安定した操作キーを使い、毎回の乱数キーを生やさない', () => {
    const schedule = PAGE.match(/const handleScheduleSend = async \(\) => \{[\s\S]*?\n  \}\n/)
    expect(schedule).not.toBeNull()
    const body = schedule![0]
    expect(body).not.toContain('crypto.randomUUID()')
    expect(body).toContain('sendKeysRef.current.get(signature)')
    expect(body).toContain('sendKeysRef.current.clear(signature)')
    // 版の識別には対象・文面・予約時刻が入る。
    expect(body).toContain("kind: 'schedule'")
    expect(body).toContain('chatId: schedulingChatId')
    expect(body).toContain('scheduledAt: scheduleInput')
    // 同じ tick の二度押しは ref のロックで止める。
    expect(body).toContain('scheduleLockRef.current')
  })
})
