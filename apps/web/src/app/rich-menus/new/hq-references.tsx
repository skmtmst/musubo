import type { Area } from '../../../components/rich-menus/area-types'
import { CreatePreviewNote, CreateSummaryCard } from '@/components/templates/create-parts'
import { emptyValue } from '@/components/shared/empty-value'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'

export default function HqMenuReferences({ areas, references }: {
  areas: Area[]
  references: RichMenuCreateHost['references']
}) {
  const groups = [
    { label: '回答フォーム', options: references.forms, ids: areas.flatMap(area => area.formId ? [area.formId] : []) },
    { label: 'テンプレート', options: references.templates, ids: areas.flatMap(area => area.templateId ? [area.templateId] : []) },
    { label: 'タグ', options: references.tags, ids: areas.flatMap(area => area.tagIds ?? []) },
  ]
  const rows = groups.flatMap(group => [...new Set(group.ids)].map(id => ({
    key: `${group.label}-${id}`,
    label: group.label,
    value: group.options.find(option => option.id === id)?.name ?? emptyValue('unknown'),
  })))
  return <CreateSummaryCard title="各アカウントで使うもの" rows={rows}>
    {rows.length === 0 ? <p className="text-body">{emptyValue('unconfigured')}</p> : null}
    <CreatePreviewNote>配った先の各アカウントで、同じ名前のものを使います。対応するものがあるかは、配る前に確かめます。</CreatePreviewNote>
  </CreateSummaryCard>
}
