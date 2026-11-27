'use client'
import { startVisiblePoll } from '@/lib/visible-polling';
import { useEffect, useState } from 'react';

type Options = {
  refreshChatDetailQuietly: () => Promise<boolean>
  channel: "email" | "all" | "line"
  loadChatsQuietly: () => Promise<boolean>
}

export function useInboxSubscription({ refreshChatDetailQuietly, channel, loadChatsQuietly }: Options) {

  /*
   * INBOX-12: 会話の定期更新。
   * 画面が見えている間だけ5秒起点で取り直す(タブを隠すと止まり、
   * 戻ると再開する)。失敗は待ちを延ばし、5回続いたら止まって理由と
   * 再試行を出す。応答を適用するのは照合を通った時だけ。
   */
  const [chatPollStalled, setChatPollStalled] = useState(false)

  const [chatPollRetryKey, setChatPollRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    setChatPollStalled(false)
    const poll = startVisiblePoll({
      work: async () => {
        const detailOk = await refreshChatDetailQuietly()
        if (!active) return
        const listOk = channel === 'email' ? true : await loadChatsQuietly()
        if (!active) return
        if (!detailOk || !listOk) throw new Error('inbox poll failed')
      },
      onGiveUp: () => { if (active) setChatPollStalled(true) },
      onRecovered: () => { if (active) setChatPollStalled(false) },
    })
    return () => { active = false; poll.stop() }
  }, [refreshChatDetailQuietly, loadChatsQuietly, channel, chatPollRetryKey])
  return { chatPollStalled, setChatPollRetryKey }
}
