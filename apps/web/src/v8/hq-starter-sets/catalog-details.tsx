'use client'
import { useEffect, useState } from 'react'
import type { StarterCatalogDetails, StarterCatalogSelection } from '@line-crm/shared'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import Button from '@/components/shared/button'
import { hqStyleApi } from '@/lib/api/helpers/styles'
import { describeApiFailure } from '@/components/shared/api-error-message'
import styles from './catalog-editor.module.css'

export function CatalogDetails({selection,onClose}:{selection:StarterCatalogSelection;onClose:()=>void}) {
  const [details,setDetails]=useState<StarterCatalogDetails|null>(null),[error,setError]=useState(''),[tick,setTick]=useState(0)
  useEffect(() => {
    let valid = true
    setDetails(null); setError('')
    void hqStyleApi.catalogDetails(selection).then((res) => {
      const reply = res as unknown as { success?: unknown; data?: unknown } | null
      const raw = reply?.data
      const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
      const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
      const lines = object(raw) && Array.isArray(raw.lines) && raw.lines.every((line: unknown) => object(line) && typeof line.label === 'string' && typeof line.value === 'string')
      const pages = object(raw) && (raw.pages === undefined || (Array.isArray(raw.pages) && raw.pages.every((page: unknown) =>
        object(page) && typeof page.name === 'string' && finite(page.width) && page.width > 0 && finite(page.height) && page.height > 0 &&
        Array.isArray(page.areas) && page.areas.every((area: unknown) => object(area) && typeof area.label === 'string' && typeof area.destination === 'string' &&
          finite(area.x) && finite(area.y) && finite(area.width) && finite(area.height)))))
      if (!reply || (reply.success !== undefined && reply.success !== true) || !object(raw) || typeof raw.name !== 'string' || !finite(raw.version) || !lines || !pages) {
        throw new Error('選んだ版の内容を確認できません。もう一度読み込んでください。')
      }
      if (valid) setDetails(raw as unknown as StarterCatalogDetails)
    }).catch((err) => { if (valid) setError(describeApiFailure(err, '読み込み', { scope: 'hq' })) })
    return () => { valid = false }
  }, [selection, tick])
  return <Dialog open title={details?`${details.name}（版${details.version}）`:'選んだ版の中身'} size="large" contentLayout="form" onCancel={onClose}
    description={details?.pages?'行き先を変えるときは、カタログで新しい版を作って選び直してください。':undefined}
    footer={details?.pages?<DialogActions><Button href={`/hq/rich-menus?mode=edit&item=${encodeURIComponent(selection.templateId)}`}>カタログを編集する</Button></DialogActions>:undefined}>
    {error?<ListState kind="error" title={error} onRetry={()=>setTick(n=>n+1)}/>:!details?<ListState kind="loading"/>:<>
      {details.pages?<>
        {details.pages.map((page,index)=><section key={index} className={styles.menuPage}><h3>{page.name}</h3><div className={styles.menuMap} style={{aspectRatio:`${page.width}/${page.height}`}} aria-label={`${page.name}のボタン配置`}>
          {page.areas.map((area,i)=><span key={i} className={styles.menuArea} style={{left:`${100*area.x/page.width}%`,top:`${100*area.y/page.height}%`,width:`${100*area.width/page.width}%`,height:`${100*area.height/page.height}%`}} title={area.label}>{i+1}</span>)}
        </div><ol className={styles.destinations}>{page.areas.map((area,i)=><li key={i}><strong>{i+1}. {area.label}</strong><span className={styles.bodyText}>{area.destination}</span></li>)}</ol></section>)}
        <p>配るときに、参照先を店のIDへ置き換えます。参照先が足りない場合は公開せず、確認待ちになります。</p></>:details.lines.length?<dl>{details.lines.map((line,i)=><div key={i}><dt>{line.label}</dt><dd className={styles.bodyText}>{line.value}</dd></div>)}</dl>:<p>本文を持たない設定です。カタログで中身を確認できます。</p>}
    </>}
  </Dialog>
}
