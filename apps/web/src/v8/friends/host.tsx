'use client'

/*
 * ★V8 /friends の入口。`?tab=` は今と同じ名前（list・duplicates・merged）を読む。
 * 画面ごとの中身は src/v8/friends/<画面>/ に置く。
 */
import { useSearchParams } from 'next/navigation'
import FriendsListV8 from './list/list'
import MergedUsersV8 from './merged/merged'
import DuplicatesListV8 from './duplicates/list'

export default function FriendsHostV8() {
  const tab = useSearchParams()?.get('tab')?.trim() ?? 'list'
  if (tab === 'merged') return <MergedUsersV8 />
  if (tab === 'duplicates') return <DuplicatesListV8 />
  return <FriendsListV8 />
}
