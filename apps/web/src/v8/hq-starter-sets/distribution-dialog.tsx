'use client'
import Dialog,{DialogActions} from '@/components/shared/dialog'
import Button from '@/components/shared/button'
import RadioCard,{RadioCardGroup} from '@/components/shared/radio-card'
import { EntityPickerField } from '@/components/shared/entity-picker'
import { useAccount } from '@/contexts/account-context'
import Notice from '@/components/shared/notice'
import { useId } from 'react'
import type { useDistribute } from './use-distribute'

export function DistributionDialog({share,lockedReason}:{share:ReturnType<typeof useDistribute>;lockedReason?:string}) {
  const {accounts}=useAccount(),draft=share.draft
  const busyReasonId = useId()
  if(!draft)return null
  return <Dialog open title="保存した初期セットを配りますか？" description="保存済みの組を、選んだアカウントへ配ります。" size="medium" busy={share.busy} error={share.error} onCancel={()=>share.setDraft(null)} footerDivider footer={<DialogActions>
    <Button disabled={share.busy} onClick={()=>share.setDraft(null)}>やめる</Button><Button variant="primary" lockedReason={lockedReason} disabled={!share.preview||share.tooMany||share.preview.accountCount===0} busy={share.busy} onClick={()=>void share.run()}>{share.preview ? `${share.preview.accountCount} アカウントへ配る` : '配る'}</Button>
  </DialogActions>}>
    {share.busy ? <Notice id={busyReasonId} tone="info" message="配布が終わるまで変更できません。" /> : null}
    <RadioCardGroup legend="配る先" legendVisible aria-describedby={share.busy ? busyReasonId : undefined}>
      <RadioCard disabled={share.busy} variant="row" name="starter-target" value="style" checked={draft.target==='style'} onChange={()=>share.setDraft({...draft,target:'style'})} title="このスタイルを使っているアカウント"/>
      <RadioCard disabled={share.busy} variant="row" name="starter-target" value="pick" checked={draft.target==='pick'} onChange={()=>share.setDraft({...draft,target:'pick'})} title="アカウントを選ぶ"/>
    </RadioCardGroup>
    {draft.target==='pick'?<EntityPickerField multiple label="配るアカウント" noun="アカウント" items={accounts.map(a=>({id:a.id,name:a.name}))} value={draft.accounts} onChange={ids=>share.setDraft({...draft,accounts:ids})} maxSelected={100} disabled={share.busy} describedBy={share.busy ? busyReasonId : undefined} lockedReason={lockedReason}/>:null}
    <RadioCardGroup legend="店が直した物があるとき" legendVisible aria-describedby={share.busy ? busyReasonId : undefined}>
      <RadioCard disabled={share.busy} variant="row" name="starter-edited" value="notify" checked={draft.editedAction==='notify'} onChange={()=>share.setDraft({...draft,editedAction:'notify'})} title="上書きせず、新しい版があると知らせる（おすすめ）"/>
      <RadioCard disabled={share.busy} variant="row" name="starter-edited" value="new_copy" checked={draft.editedAction==='new_copy'} onChange={()=>share.setDraft({...draft,editedAction:'new_copy'})} title="上書きせず、新しく写して入れる"/>
    </RadioCardGroup>
    {share.preview ? <p>{`対象 ${share.preview.accountCount} アカウント・確認が必要な物 ${share.preview.editedCount} 件`}</p> : share.preflightFailed ? <Button type="button" onClick={share.retryPreflight}>もう一度確かめる</Button> : <p>配る先を確かめています…</p>}
    <p>配った後も、自動応答は停止、テンプレート・クーポン・フォーム・メニューは未公開です。</p>
  </Dialog>
}
