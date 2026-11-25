'use client'
import { usePageTitle } from '@/components/shell/page-chrome'
import { useEffect, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { styleApi } from '@/lib/api/helpers/styles'
import { accountStyleUpdated } from '@/hooks/use-account-style'
import { CreatePage } from '@/components/templates/create-page'
import { PageContent, PageFrame, PageHeading } from '@/components/templates/page-frame'
import PagePending from '@/components/templates/page-pending'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { InitialMenuChoice, InitialMenuPhone, type InitialMenuSelection } from './initial-menu-choice'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

const MENU_TITLE = 'リッチメニュー'

export default function InitialMenuPage() {
 const saveErrors=useSaveFormErrors()
 const {selectedAccountId}=useAccount(),role=useStaffRole(),router=useRouter()
 const profile=useAccountStyle(selectedAccountId)
 const styleReady=profile.status==='ready'&&!profile.stale&&Boolean(profile.data?.styleSelected)
 const useRestaurantGuide=styleReady&&profile.data?.style==='restaurant'
 usePageTitle(styleReady&&!useRestaurantGuide?'最初のリッチメニューを選ぶ':MENU_TITLE)
 const [choice,setChoice]=useState<InitialMenuSelection>({value:'simple'}),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[dirty,setDirty]=useState(false)
 useEffect(()=>{setChoice({value:'simple'});setDirty(false);setError(null)},[selectedAccountId])
 useEffect(()=>{if(useRestaurantGuide)router.replace('/?guide=richMenu')},[router,useRestaurantGuide])
 const allowed=canManageRole(role),style=profile.data?.style??'standard'
 const save=async()=>{
  if(!allowed||!selectedAccountId||!profile.data?.styleSelected||profile.stale||busy)return
  const account=selectedAccountId,version=profile.data.version
  setBusy(true);setError(null);saveErrors.reset()
  try{
   if(choice.value==='existing'&&!choice.resourceId)throw new Error('使うリッチメニューを選んでください')
   const set=await styleApi.starterSet(account,style,choice.value==='simple')
   if(!set.success)throw new Error('メニューを確認できませんでした')
   const key=set.data.definition.items.find(item=>item.kind==='rich_menu')?.key
   const image=choice.value==='later'?{mode:'later' as const}:{mode:'configured' as const,value:choice.value==='simple'?'simple':'existing',...(choice.value==='existing'?{resourceId:choice.resourceId}:{})}
   const choices=key&&choice.value!=='later'?{[key]:choice.value==='existing'?{mode:'existing' as const,resourceId:choice.resourceId!}:{mode:'sample' as const}}:undefined
   const result=await styleApi.save(account,{expectedVersion:version,confirmInitialMenu:choice.value==='simple',answers:{image},choices})
   if(!result.success)throw new Error('メニューを保存できませんでした')
   accountStyleUpdated(account);setDirty(false);router.push('/getting-started')
  }catch(error){if(!saveErrors.capture(error))setError(describeApiFailure(error,'保存'))}finally{setBusy(false)}
 }
 if (profile.status === 'error' || profile.stale) return <PagePending stage="style" title={MENU_TITLE} failed
   errorTitle="使い方を読み込めませんでした" error={profile.error} onRetry={profile.reload} />
 if (!selectedAccountId || profile.status !== 'ready' || useRestaurantGuide) return <PagePending stage="style" title={MENU_TITLE}
   loadingTitle="使い方を確認しています" />
 if (!styleReady) return (
  <PageFrame kind="detail">
   <PageHeading title={MENU_TITLE} />
   <PageContent>
    <Notice tone="info">使い方のスタイルを先に選んでください。<Button href="/?setup=0&setupReturn=accounts">使い方を選ぶ</Button></Notice>
   </PageContent>
  </PageFrame>
 )
 return <SaveErrorScope errors={saveErrors}><CreatePage title="最初のリッチメニューを選ぶ" help="画像とボタンの行き先がセットで入ります。あとから変更できます。" dirty={dirty} busy={busy} readOnly={!allowed} contentDisabled={!allowed||busy} bodyEndActions={<><Button href="/form-submissions">ページの内容を直す</Button><Button href="/rich-menus">LINEに出す前に確認する</Button></>} preview={choice.value==='simple'?<InitialMenuPhone style={style}/>:undefined} previewLabel="お客さまの見え方" footerActions={<><Button onClick={()=>router.push('/getting-started')} disabled={busy}>キャンセル</Button><Button variant="primary" onClick={()=>void save()} busy={busy} disabled={!allowed||profile.status!=='ready'||profile.stale||!profile.data?.styleSelected||(choice.value==='existing'&&!choice.resourceId)} disabledReason={!allowed?'オーナー・管理者が設定できます':null}>このメニューで進む</Button></>}>
  {error?<Notice tone="danger">{String(error)}</Notice>:null}
  <InitialMenuChoice accountId={selectedAccountId} style={style} value={choice} onChange={next=>{setChoice(next);setDirty(true)}} disabled={!allowed||busy} disabledReason={!allowed?'オーナー・管理者が設定できます':'保存中は変更できません'}/>
 </CreatePage></SaveErrorScope>
}
