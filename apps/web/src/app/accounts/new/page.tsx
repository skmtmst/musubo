'use client'

import { Suspense } from 'react'
import AccountRegisterV8 from '@/v8/account-new/register'

export default function NewLineAccountPage() {
  return <Suspense><AccountRegisterV8 /></Suspense>
}
