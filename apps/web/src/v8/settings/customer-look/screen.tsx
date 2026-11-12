'use client'
import {useEffect,useRef,useState} from 'react'
import {DEFAULT_CUSTOMER_LOOK,customerPalette,customerLookError,type CustomerLook} from '@line-crm/shared'
import {SettingsPage} from '@/components/templates/settings-page'
import SettingsInnerNav from '@/components/layout/settings-inner-nav'
import {usePageTitle,usePageCrumbs,useHideSettingsNav} from '@/components/shell/page-chrome'
import {useAccount} from '@/contexts/account-context'
import {useStaffRole,canManageRole} from '@/lib/staff-role'
import {api,ApiError} from '@/lib/api'
import {japaneseDetailOf} from '@/components/shared/api-error-message'
import {useUnsavedGuard} from '@/lib/use-unsaved-guard'
import {UnsavedLeaveDialog} from '@/lib/unsaved-leave-dialog'
import {SaveErrorScope,useSaveFormErrors} from '@/components/shared/save-form-errors'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import ColorWell from '@/components/shared/color-well'
import {Field,FieldError} from '@/components/shared/form-controls'
import Select from '@/components/shared/select'
import SectionHeader from '@/components/shared/section-header'
import Disclosure, { DisclosureNote } from '@/components/shared/disclosure'
import CustomerDesignPicker from '@/components/shared/customer-design-picker'
import CustomerLookPreview from '@/components/shared/customer-look-preview'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import {usePermissionLockReason} from '@/components/shared/use-permission-lock-reason'
import {lockReason} from '@/components/shared/permission-lock'
import ListState from '@/components/shared/list-state'
import {useSaveConflict} from '@/components/shared/save-conflict'
import {notifyToast} from '@/components/shared/toast'
export default function CustomerLookScreen() {
 usePageTitle('お客さまの画面のデザイン');usePageCrumbs([{label:'設定',href:'/settings'}]);useHideSettingsNav()
 const {selectedAccountId,selectedAccount,accounts}=useAccount();const role=useStaffRole();const canEditRole=canManageRole(role)
 const accountName=(selectedAccount?.id===selectedAccountId?selectedAccount?.name:accounts.find(account=>account.id===selectedAccountId)?.name)?.trim()||'店名未取得'
 const permissionReason=usePermissionLockReason(canEditRole,'manager');const canEdit=canEditRole&&!permissionReason
 const [saved,setSaved]=useState<CustomerLook | null>(null),[draft,setDraft]=useState<CustomerLook>({...DEFAULT_CUSTOMER_LOOK})
 const [version,setVersion]=useState(0),[status,setStatus]=useState<'loading'|'ready'|'error'>('loading'),[error,setError]=useState(''),[saving,setSaving]=useState(false),[retry,setRetry]=useState(0)
 const {conflict,mark:markConflict,clear:clearConflict}=useSaveConflict({contextKey:selectedAccountId??'',fetchLatest:async()=>{if(!selectedAccountId)return null;const result=await api.accountSettings.getCustomerLook(selectedAccountId);if(!result.success)throw new Error(result.error);return result.data},reload:()=>reloadLatest()})
 const saveErrors=useSaveFormErrors()
 const generation=useRef(0)
 useEffect(()=>{const request=++generation.current;setStatus('loading');setSaved(null);setError('');setSaving(false);clearConflict()
  if(!selectedAccountId)return
  api.accountSettings.getCustomerLook(selectedAccountId).then(result=>{if(request!==generation.current)return;if(!result.success)throw new Error(result.error);setSaved(result.data.look);setDraft(result.data.look);setVersion(result.data.version);setStatus('ready')}).catch(()=>{if(request===generation.current){setStatus('error');setError('デザインを読み込めませんでした')}})
  return()=>{generation.current++}
 },[selectedAccountId,retry])
 const dirty=!!saved && JSON.stringify(saved)!==JSON.stringify(draft)
 const guard=useUnsavedGuard({dirty,busy:saving})
 const patch=(next:Partial<CustomerLook>)=>{if(canEdit&&!saving&&!lockReason(canEditRole,'manager'))setDraft(current=>({...current,...next}))}
 const save=async()=>{
  if(!canEdit||lockReason(canEditRole,'manager')||saving||!dirty||conflict||!selectedAccountId||!saved)return false
  const invalid=customerLookError(draft);if(invalid){setError(invalid);return false}
  const request=generation.current;setSaving(true);setError('')
  try {const result=await api.accountSettings.saveCustomerLook(selectedAccountId,draft,version);if(request!==generation.current)return false;
   if(!result.success||!result.data)throw new Error(result.error??'保存できませんでした。時間をおいて、もう一度お試しください。');setSaved(result.data.look);setDraft(result.data.look);setVersion(result.data.version);guard.disarm();notifyToast('お客さまの画面のデザインを保存しました');return true
  }catch(failure){if(request===generation.current){if(failure instanceof ApiError&&failure.status===409)markConflict();if(!saveErrors.capture(failure))setError(japaneseDetailOf(failure)||'保存できませんでした。時間をおいて、もう一度お試しください。')}return false}
  finally{if(request===generation.current)setSaving(false)}
 }
 const reloadLatest=async()=>{
  if(saving||!selectedAccountId)return
  const request=generation.current;setSaving(true)
  try{const result=await api.accountSettings.getCustomerLook(selectedAccountId);if(request!==generation.current)return;if(!result.success)throw new Error(result.error);setSaved(result.data.look);setVersion(result.data.version);clearConflict();setError('');saveErrors.reset()}
  catch(failure){if(request===generation.current)setError(japaneseDetailOf(failure)||'最新のデザインを読み込めませんでした')}
  finally{if(request===generation.current)setSaving(false)}
 }
 return <SaveErrorScope errors={saveErrors}><SettingsPage title="お客さまの画面のデザイン" layout="customer-look" navigation={<SettingsInnerNav inline/>}
  help={canEdit ? '予約・回答フォーム・履歴・スタンプなど、お客さまに見える画面のデザインを決めます。型を選ぶと右の見本が変わり、保存するとお客さまの画面に反映されます。' : '予約・回答フォーム・履歴・スタンプなど、お客さまに見える画面のデザインです。'}
  notice={status==='ready'&&role!==null&&!canEdit?<ReadOnlyNotice need="manager"/>:undefined}
  preview={status==='ready'?<CustomerLookPreview accountId={selectedAccountId} look={draft} accountName={accountName}/>:undefined}
  saveStatus={error?<><FieldError id="customer-look-save-error">{error}</FieldError>{conflict?<Button disabled={saving} onClick={()=>void reloadLatest()}>最新を読み直す</Button>:null}</>:undefined}
  saveActions={status==='ready'&&(dirty||saving||!canEdit)?<>{dirty||saving?<Button disabled={saving||!dirty} disabledReason={saving ? '保存しています' : !dirty ? '変更していません' : undefined} onClick={()=>guard.guarded(()=>{if(saved)setDraft(saved);setError('')})}>キャンセル</Button>:null}<Button variant="primary" lockedReason={permissionReason} disabled={!canEdit||!dirty||!!conflict} disabledReason={permissionReason||role===null?undefined:conflict ? '最新のデザインを読み直してから保存してください' : !dirty ? '変更していません' : undefined} busy={saving} onClick={()=>save()}>保存する</Button></>:undefined}>
   {!selectedAccountId?<ListState kind="empty" title="店を選んでください"/>:status==='loading'?<ListState kind="loading" title="デザインを読み込んでいます"/>:status==='error'?<ListState kind="error" title={error} action={<Button onClick={()=>setRetry(current=>current+1)}>もう一度読み込む</Button>}/>:<>
    <Card padding="roomy" layout="vertical" gap="normal"><SectionHeader title="デザインの型" description={canEdit ? "型を押すと、右の見本がすぐ変わります" : "予約・回答フォームなどに使われるデザインです"}/>
     <CustomerDesignPicker value={draft.preset} columns={2} readOnly={!canEdit||saving} onChange={preset=>patch({preset})}/>
     {/* 型の下に「カスタムの色と書体」の開け閉めする段を常に置く（VsZ25）。入力できるのはカスタムを選んだときだけ。 */}
     <Disclosure appearance="inset" size="compact" key={draft.preset==='custom'?'custom':'preset'} title="カスタムの色と書体" hint="主の色・背景の色・見出しの書体" defaultOpen={draft.preset==='custom'}>{draft.preset==='custom'?<>
      <Field label="主の色"><ColorWell disabled={!canEdit||saving} label="主の色" value={draft.primaryColor??customerPalette(DEFAULT_CUSTOMER_LOOK).main} allowAlpha={false} allowClear={false} onChange={value=>value&&patch({primaryColor:value})}/></Field>
       <Field label="背景の色"><ColorWell disabled={!canEdit||saving} label="背景の色" value={draft.backgroundColor??customerPalette(DEFAULT_CUSTOMER_LOOK).background} allowAlpha={false} allowClear={false} onChange={value=>value&&patch({backgroundColor:value})}/></Field>
       <Field label="見出しの書体"><Select disabled={!canEdit||saving} aria-label="見出しの書体" value={draft.headingFont} onChange={headingFont=>patch({headingFont:headingFont as CustomerLook['headingFont']})} options={[{value:'default',label:'型に合わせる'},{value:'mincho',label:'明朝'},{value:'marugothic',label:'丸いゴシック'},{value:'sans',label:'ゴシック'}]}/></Field>
     </>:<DisclosureNote>型の色と書体を使っています。自分で決めるときは、上の「カスタム」を選んでください。</DisclosureNote>}</Disclosure>
    </Card>
   </>}
 </SettingsPage><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={saving} subject="デザインの変更" onSave={save} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave}/></SaveErrorScope>
}
