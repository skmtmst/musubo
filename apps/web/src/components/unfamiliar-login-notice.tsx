'use client'

import { useEffect, useState } from 'react'
import { adminSessionHeaders } from '@/lib/admin-session'
import { readSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import TrustCurrentLogin from '@/components/trust-current-login'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'

const CLOSED_PREFIX = 'notice-closed:unfamiliar-login:'

/** 閉じたログイン（unfamiliarAt）だけを、この端末で覚える。別のいつもと違うログインはまた出す。 */
function useClosedForLogin(unfamiliarAt: string | null) {
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (!unfamiliarAt) return
    try { setClosed(localStorage.getItem(CLOSED_PREFIX + unfamiliarAt) === '1') } catch { setClosed(false) }
  }, [unfamiliarAt])
  const close = () => {
    setClosed(true)
    if (!unfamiliarAt) return
    try { localStorage.setItem(CLOSED_PREFIX + unfamiliarAt, '1') } catch { /* この画面の間だけ閉じる */ }
  }
  return { closed, close }
}

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
 * ［閉じる］で、そのログインについてはその端末でずっと出さない。どの画面でも閉じられる。
 * 別のいつもと違うログインがあれば、また出す（知らない人のログインに気づけるようにするため）。
 */
export default function UnfamiliarLoginNotice({ className }: { className?: string }) {
  const [unfamiliarAt, setUnfamiliarAt] = useState<string | null>(null)
  const { closed, close } = useClosedForLogin(unfamiliarAt)

  useEffect(() => {
    const update = () => setUnfamiliarAt(readSessionSnapshot()?.unfamiliarAt ?? null)
    window.addEventListener(SESSION_SNAPSHOT_CHANGED, update)
    return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, update)
  }, [])

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

  if (!unfamiliarAt || closed) return null
  return (
    <Notice
      className={className}
      tone="warn"
      heading="いつもと違う端末・場所からのログインです"
      message="大事な操作の前に毎回、本人確認をします。心当たりがなければ、ほかの端末のログインを終えてパスワードを変えてください。"
      action={<><TrustCurrentLogin /><Button href="/staff?section=sessions" variant="secondary">ログイン中の端末を見る</Button></>}
      onClose={close}
    />
  )
}
