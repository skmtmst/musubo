'use client'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import StickyBar from '@/components/shared/sticky-bar'
import { PageFrame, PageHeading, PageContent } from '@/components/templates/page-frame'
import Step4Template from './step4-template'
import RegistrationStyleDialog from './registration-style-dialog'
import { useRegistrationStyle } from './use-registration-style'
import { useState } from 'react'
import { useAccount } from '@/contexts/account-context'
import RegistrationUnsavedGuard from './registration-unsaved-guard'

export default function ResumeRegistrationStyle({ accountId }: { accountId: string }) {
  const { accounts } = useAccount()
  const accountName = accounts.find(account => account.id === accountId)?.name
  const state = useRegistrationStyle(accountId, true)
  const [done, setDone] = useState<'saved' | 'skipped' | null>(null)
  const [dialogOpen, setDialogOpen] = useState(true)
  const finish = async (action: 'save' | 'skip') => {
    if (await state[action]()) { setDialogOpen(false); setDone(action === 'save' ? 'saved' : 'skipped') }
  }
  return <PageFrame kind="wizard" boardId="X0pGdw">
    <PageHeading title={done === 'saved' ? '使い方を保存しました' : done === 'skipped' ? '登録が完了しました' : '使い方を選ぶ'} />
    <PageContent layout="stats">
      <Notice tone="info">LINEアカウントは登録済みです。使い方はあとから設定で変更できます。</Notice>
      {state.error ? <ListState kind="error" title="使い方を確認・保存できませんでした" error={state.error} onRetry={state.reload} /> : null}
      {done ? <Button href={done === 'saved' && state.choice === 'restaurant' ? `/restaurant-test/stores/new?accountId=${encodeURIComponent(accountId)}` : '/hq'}>次へ</Button> : <>
        <Step4Template templateKey={state.choice} onOpen={() => setDialogOpen(true)} />
        <RegistrationStyleDialog
          accountName={accountName}
          open={dialogOpen}
          choice={state.choice}
          busy={state.busy}
          ready={state.version !== null}
          error={state.error}
          onChoose={state.setChoice}
          onSave={() => void finish('save')}
          onSkip={() => void finish('skip')}
          onClose={() => setDialogOpen(false)}
        />
      </>}
      <Button href={`/accounts/detail?id=${encodeURIComponent(accountId)}`}>登録したアカウントを見る</Button>
    </PageContent>
    {!done ? <StickyBar actions={<>
      <Button type="button" onClick={() => setDialogOpen(true)} disabled={state.busy}>スタイルを選ぶ</Button>
      <Button type="button" onClick={() => void finish('skip')} disabled={state.busy || state.version === null} busy={state.busy}>あとで設定する</Button>
    </>} /> : null}
    {!done ? <RegistrationUnsavedGuard dirty={state.dirty} busy={state.busy} onDiscard={state.discard} /> : null}
  </PageFrame>
}
