'use client'

import { useEffect, useState, type ReactNode } from 'react'
import ListState from '@/components/shared/list-state'
import { PageContent, PageFrame, PageHeading } from '@/components/templates/page-frame'
import { PENDING_REGISTRATION_RECEIPT } from './registration-storage'

/** 明示されたアカウントを優先し、本人の控えはIDの復元にだけ使う。 */
export default function RegistrationSession({ resumeKey, explicitId, children }: {
  resumeKey: string | null
  explicitId: string | null
  children: (accountId: string) => ReactNode
}) {
  const [resumeId, setResumeId] = useState<string>()
  useEffect(() => {
    let id = explicitId ?? ''
    try { if (!id && resumeKey) id = sessionStorage.getItem(resumeKey) ?? '' } catch { /* 控えが読めなくても登録できる。 */ }
    setResumeId(id.startsWith(PENDING_REGISTRATION_RECEIPT) ? id.slice(PENDING_REGISTRATION_RECEIPT.length) : id)
  }, [resumeKey, explicitId])

  if (resumeId === undefined) return <PageFrame kind="wizard" boardId="p6zMkA">
    <PageHeading title="LINEアカウントを登録" />
    <PageContent layout="stats"><ListState kind="loading" title="登録の状態を確認しています" /></PageContent>
  </PageFrame>
  return children(resumeId)
}
