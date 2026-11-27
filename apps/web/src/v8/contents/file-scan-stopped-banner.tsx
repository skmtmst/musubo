'use client'


import { useEffect, useState } from 'react'
import NoteBar from '@/components/shared/note-bar'
import { api } from '@/lib/api'

/**
 * 検査が止まっている時の帯。
 *
 * 上げたファイルは持ちのまま、確かめ終わるまで使えない。
 * 赤は使わない。読み込めなかった時とは別の帯のため、
 * この帯が出ている間は他の帯と並べない（呼び出し側で1本に寄せる）。
 */
export default function FileScanStoppedBanner({ accountId }: { accountId: string | null }) {
  const [health, setHealth] = useState<{ accountId: string; stopped: boolean } | null>(null)

  useEffect(() => {
    // 帯が画面を壊さない。検査の口が無い古い応答でも黙って出さない。
    const readHealth = api.fileScan?.health
    if (!accountId || !readHealth) return
    let alive = true
    readHealth(accountId).then((res) => {
      if (alive && res.success) setHealth({ accountId, stopped: res.data.stopped })
    }).catch(() => {})
    return () => { alive = false }
  }, [accountId])

  if (!accountId || health?.accountId !== accountId || !health.stopped) return null
  return (
    <NoteBar tone="warn">
      ファイルの安全確認が止まっています。上げたファイルは持ちのまま、確かめ終わるまで使えません。しばらくしてから自動で続きます。
    </NoteBar>
  )
}
