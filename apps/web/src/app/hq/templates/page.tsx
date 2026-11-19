'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { TEMPLATE_TYPES, type TemplateType } from '@/lib/hq-templates-api'
import HqTemplatesV8 from '@/v8/hq-templates/console'
import CatalogRewards from '@/v8/hq-templates/catalog-reward'
import TemplateDefinitionEditor from './template-definition-editor'
import HqDeliveryConsole from '@/v8/hq-deliveries/console'
import { HQ_DELIVERY_TEMPLATE_TYPES, type HqDeliveryTemplateType } from '@line-crm/shared'

/** `/hq/templates?type=...` は旧URLとして残し、新しい正規画面へ同じ内容を出す。 */
function Content() {
  const requested = useSearchParams().get('type')
  if (requested === 'mileage_reward') return <CatalogRewards />
  if (requested && HQ_DELIVERY_TEMPLATE_TYPES.includes(requested as HqDeliveryTemplateType)) {
    return <HqDeliveryConsole type={requested as HqDeliveryTemplateType} />
  }
  const type = requested && TEMPLATE_TYPES.includes(requested as TemplateType)
    ? requested as TemplateType
    : 'template'
  /*
   * ★V8（・・）は src/v8 の新しい画面。タグ・リッチメニュー・回答フォーム・
   * シナリオのひな形の中身は、今の編集部品をそのまま渡す（src/v8 は @/app を読まないため）。
   */
  return <HqTemplatesV8 type={type} DefinitionEditor={TemplateDefinitionEditor} />
}

export default function HqTemplatesPage() {
  return <Suspense fallback={<p role="status">テンプレートを読み込み中…</p>}><Content /></Suspense>
}
