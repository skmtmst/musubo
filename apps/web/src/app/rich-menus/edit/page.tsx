'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { DetailLoading } from '@/components/templates/detail-page'
import TargetMissing from '@/components/shared/target-missing'
import RichMenuCreateV8 from '../../../v8/rich-menus/new/create'
import RichMenuDetailV8 from '@/v8/rich-menu-edit/detail'

function RichMenuEditEntry() {
  const searchParams = useSearchParams()
  const groupId = searchParams.get('id') ?? ''
  if (!groupId) return <TargetMissing
    kind="unspecified"
    title="編集するリッチメニューが指定されていません"
    description="一覧から編集するリッチメニューを選び直してください。"
    backHref="/rich-menus"
    backLabel="リッチメニュー一覧へ戻る"
  />
  const step = searchParams.get('step')
  return step
    ? <RichMenuCreateV8 editGroupId={groupId} initialStep={step} />
    : <RichMenuDetailV8 groupId={groupId} />
}

export default function RichMenuEditPage() {
  return <Suspense fallback={<DetailLoading />}><RichMenuEditEntry /></Suspense>
}
