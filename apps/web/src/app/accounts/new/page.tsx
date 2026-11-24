'use client'

import { Suspense } from 'react'
import PagePending from '@/components/templates/page-pending'
import AccountRegisterV8 from '@/v8/account-new/register'

export default function NewLineAccountPage() {
  return <Suspense fallback={<PagePending stage="route" title="LINEアカウントを登録" loadingTitle="登録の状態を確認しています" />}>
    <AccountRegisterV8 />
  </Suspense>
}
