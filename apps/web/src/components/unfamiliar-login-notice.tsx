'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { adminSessionHeaders } from '@/lib/admin-session'
import { readSessionSnapshot } from '@/lib/session-snapshot'
import Notice, { useNoticeClosedToday } from '@/components/shared/notice'
import Button from '@/components/shared/button'
import { isSecurityNoticePinned } from '@/components/security-notice-paths'

/**
 * V-2: いつもと違う端末・場所からのログインの知らせ（管理画面-30 §14）。
 * 白い板の中の白いカード1枚で出す（§6.32 案A）。
 *
 * /api/auth/session が unfamiliarAt を返すときだけ描く。帯は AuthGuard の
 * 内側に載るので、答えは AuthGuard が取ったものを読む（readSessionSnapshot）。
 * 手元に無いときだけ自分で取りに行く。
 *
 * この帯が出ているあいだ、そのセッションの大事な操作は毎回の本人確認が要る
 * （Worker側で強制）。心当たりがない人の逃げ道として、セッション管理への
 * リンク（他の端末のログイン解除）を右に置く。
 * ［閉じる］でその日は（その端末で）出さない。ダッシュボードと設定の画面には残す。
 */
export default function UnfamiliarLoginNotice({ className }: { className?: string }) {
  const [unfamiliarAt, setUnfamiliarAt] = useState<string | null>(null)
  const pathname = usePathname()
  const pinned = isSecurityNoticePinned(pathname)
  const { closed, close } = useNoticeClosedToday(`unfamiliar-login:${unfamiliarAt ?? ''}`)

  useEffect(() => {
    let cancelled = false
    const known = readSessionSnapshot()
    const fetchWhenMissing = () =>
      fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/session`, {
        credentials: 'include',
        headers: adminSessionHeaders(),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { data?: { unfamiliarAt?: string | null } } | null) => body?.data?.unfamiliarAt ?? null)
    const resolved = known ? Promise.resolve(known.unfamiliarAt) : fetchWhenMissing()
    resolved
      .then((value) => { if (!cancelled) setUnfamiliarAt(value) })
      .catch(() => { if (!cancelled) setUnfamiliarAt(null) })
    return () => { cancelled = true }
  }, [])

  if (!unfamiliarAt || (closed && !pinned)) return null
  return (
    <Notice
      className={className}
      tone="warn"
      heading="いつもと違う端末・場所からのログインです"
      message="大事な操作の前に毎回、本人確認をします。心当たりがなければ、ほかの端末のログインを終えてパスワードを変えてください。"
      action={<Button href="/staff?section=sessions" variant="secondary">ログイン中の端末を見る</Button>}
      onClose={pinned ? undefined : close}
    />
  )
}
