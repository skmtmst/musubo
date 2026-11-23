'use client'
import {useState} from 'react'
import Dialog from '@/components/shared/dialog'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import type {StarterSetItem} from '@/lib/api/helpers/styles'
import styles from './catalog-editor.module.css'
import { legacyRemovalKeys } from './legacy-removal'

export function LegacyDetails({items,busy,error,lockedReason,canRemove,onRemove,onClose}:{items:StarterSetItem[]|null;busy:boolean;error:string;lockedReason?:string;canRemove:boolean;onRemove:(key:string)=>Promise<void>;onClose:()=>void}) {
 const [removing,setRemoving]=useState<string|null>(null)
 return <><Dialog open title="現在の初期セット" error={error} busy={busy} onCancel={onClose}>
  {items===null?<ListState kind="loading"/>:items.length?<ul className="text-body">{items.map(item=><li key={item.key}><strong>{item.name}</strong>{item.text?<p className={styles.bodyText}>{item.text}</p>:null}{item.buttons?<p>{item.buttons.map(b=>b.label).join('・')}</p>:null}<Button size="compact" lockedReason={lockedReason} disabled={busy||!canRemove} onClick={()=>setRemoving(item.key)}>初期セットから外す</Button></li>)}</ul>:<p className="text-body">入れる物はありません。</p>}
 </Dialog><ConfirmDialog open={removing!==null} title="初期セットから外しますか？" description={`${removing && items && legacyRemovalKeys(items,removing).size>1 ? '4面メニューと、それにつながるフォーム・ご案内を一緒に外します。' : ''}これから作るアカウントには入りません。既存のお店の内容は変わりません。`} confirmLabel="外す" destructive busy={busy} error={error} onCancel={()=>setRemoving(null)} onConfirm={()=>{if(removing)return onRemove(removing).then(()=>setRemoving(null),()=>{})}}/></>
}
