'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { NotificationCenterItem } from '@line-crm/shared'
import MobileScreen from '@/components/mobile/mobile-screen'
import { useMobileShell } from '@/components/mobile/mobile-shell'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import { MobileCardLink, MobileCardList, MobileSection, MobileTalkList, type MobileTalkItem } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { api, type ChatListItem } from '@/lib/api'
import { formatListRecent, formatListRecentTitle } from '@/lib/format'
import { mobileHrefForPcPath } from '@/lib/mobile-shell'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { talkItem } from '@/v8/inbox-chat/public/mobile-talk-item/index'
import { notificationDestination } from '@/v8/notifications/public/destination/index'
import styles from './todo.module.css'

/*
 * 電話の画面の「対応」（/m/todo）。すぐ対応が要るものをカード 1 列で並べる。
 * - 返事を待っているトーク：受信箱の「未対応」と同じ（受信箱を見る権限がある人だけ）。押すとトークを開く。
 * - 確かめるお知らせ：通知の中心の「エラー」のうち、まだ読んでいない物。押すと既読にして行き先を開く
 *   （電話の画面に当たる画面が無い物は PC の画面を開く）。
 * 口（API）は PC と同じ。新しい口は作らない。アカウントを切り替えた時は前の店の行を出さない。
 */

const TALK_LIMIT = 20
const NOTICE_LIMIT = 20

type Loaded<T> = { accountId: string; rows: T[] } | { accountId: string; failed: true }

export default function MobileTodoScreen() {
  return (
    <MobileScreen title="対応">
      <MobileTodoBody />
    </MobileScreen>
  )
}

function MobileTodoBody() {
  const shell = useMobileShell()
  const role = useStaffRole()
  const { selectedAccountId } = useAccount()
  const canSeeTalk = shell.canView('/chats')
  const [talks, setTalks] = useState<Loaded<ChatListItem> | null>(null)
  const [notices, setNotices] = useState<Loaded<NotificationCenterItem> | null>(null)
  const [, setClockTick] = useState(0)
  const now = Date.now()
  const generation = useRef(0)

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setClockTick((value) => value + 1) }
    const interval = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', refresh) }
  }, [])

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    const mine = ++generation.current
    const accountId = selectedAccountId
    const talkRequest = canSeeTalk
      ? api.chats.list({ status: 'unread', accountId, limit: TALK_LIMIT })
        .then((res): Loaded<ChatListItem> => (res.success ? { accountId, rows: res.data } : { accountId, failed: true }))
        .catch((): Loaded<ChatListItem> => ({ accountId, failed: true }))
      : Promise.resolve<Loaded<ChatListItem>>({ accountId, rows: [] })
    const noticeRequest = api.notifications.center.list(accountId, { category: 'error', limit: NOTICE_LIMIT })
      .then((res): Loaded<NotificationCenterItem> => (res.success ? { accountId, rows: res.data.items.filter((item) => !item.isRead) } : { accountId, failed: true }))
      .catch((): Loaded<NotificationCenterItem> => ({ accountId, failed: true }))
    const [talkResult, noticeResult] = await Promise.all([talkRequest, noticeRequest])
    // 待つ間にアカウントを切り替えたら、前の店の答えは捨てる。
    if (mine !== generation.current) return
    setTalks(talkResult)
    setNotices(noticeResult)
  }, [selectedAccountId, canSeeTalk])

  useEffect(() => {
    setTalks(null)
    setNotices(null)
    void load()
  }, [load])

  const current = <T,>(value: Loaded<T> | null) => (value && value.accountId === selectedAccountId ? value : null)
  const talkState = current(talks)
  const noticeState = current(notices)
  if (!talkState || !noticeState) return <ListState kind="loading" title="対応が要るものを読み込んでいます" />

  const talkRows = 'rows' in talkState ? talkState.rows : null
  const noticeRows = 'rows' in noticeState ? noticeState.rows : null
  if (talkRows?.length === 0 && noticeRows?.length === 0) {
    return <ListState kind="empty" emptyPreset="readonly" title="今、対応が要るものはありません" description="新しい問い合わせやエラーが届くと、ここに出ます。" />
  }

  const openTalk = (item: MobileTalkItem) => {
    // 既読はログイン中の担当者だけに付く。対応の状態は変えない（PC で会話を開いた時と同じ）。
    void api.chats.markRead(item.id).catch(() => {
      // 会話を開く操作は止めない。
    })
  }
  const openNotice = (item: NotificationCenterItem) => {
    if (!selectedAccountId) return
    void api.notifications.center.markRead(item.id, selectedAccountId).catch(() => {
      // 開く操作は止めない。次の読み直しで正しい既読に戻る。
    })
  }
  const destinationContext = { accountId: selectedAccountId, canManage: canManageRole(role) }

  return (
    <div className={styles.stack}>
      {canSeeTalk ? (
        <MobileSection title="返事を待っているトーク" count={talkRows ? talkRows.length : null} action={talkRows && talkRows.length >= TALK_LIMIT ? <Button href="/m/chats" variant="text" size="compact">すべて見る</Button> : null}>
          {talkRows === null ? (
            <ListState kind="error" title="トークを読み込めませんでした" onRetry={() => { void load() }} />
          ) : talkRows.length === 0 ? (
            <ListState kind="empty" emptyPreset="readonly" title="返事を待っているトークはありません" />
          ) : (
            <MobileTalkList label="返事を待っているトーク" items={talkRows.map(talkItem)} onOpen={openTalk} />
          )}
        </MobileSection>
      ) : null}
      <MobileSection title="確かめるお知らせ" count={noticeRows ? noticeRows.length : null}>
        {noticeRows === null ? (
          <ListState kind="error" title="お知らせを読み込めませんでした" onRetry={() => { void load() }} />
        ) : noticeRows.length === 0 ? (
          <ListState kind="empty" emptyPreset="readonly" title="確かめるお知らせはありません" />
        ) : (
          <MobileCardList label="確かめるお知らせ">
            {noticeRows.map((item) => {
              const pcHref = notificationDestination(item, destinationContext)
              const mobileHref = mobileHrefForPcPath(pcHref)
              return (
                <MobileCardLink key={item.id} href={mobileHref ?? pcHref} onClick={() => openNotice(item)} label={mobileHref ? undefined : `${item.title}（PC の画面で開く）`}>
                  <span className={styles.notice}>
                    <span className={styles.noticeHead}>
                      <StatusBadge tone="danger" size="compact">エラー</StatusBadge>
                      <time className={styles.time} title={formatListRecentTitle(item.createdAt, { now }) || undefined}>{formatListRecent(item.createdAt, { now })}</time>
                    </span>
                    <span className={styles.noticeTitle} title={item.title}>{item.title}</span>
                    {item.body ? <span className={styles.noticeBody}>{item.body}</span> : null}
                    {mobileHref ? null : <span className={styles.pcLink}>PC の画面で開く</span>}
                  </span>
                </MobileCardLink>
              )
            })}
          </MobileCardList>
        )}
      </MobileSection>
    </div>
  )
}
