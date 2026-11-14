import type { ReactNode } from 'react'
import { ArrowUpDown } from 'lucide-react'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import { CreateSummaryCard } from '@/components/templates/create-parts'

export function PhotoReviewHelp({ pending, adopted, rejected }: { pending: string; adopted: string; rejected: string }) {
  return <>お客さまが送ってくれたペットの写真を確かめて、公式サイトに載せるかを決めます。<br />
    <strong>審査待ち</strong>：<span>{pending}</span><br />
    <strong>今月 採用</strong>：<span>{adopted}</span><br />
    <strong>今月 見送り</strong>：<span>{rejected}</span><br />
    <strong>公式サイト掲載</strong>：<span>いま載っている写真の枚数です。</span>
  </>
}

const PUBLICATION_RULES: readonly ReactNode[] = [
  '投稿のときに公開への同意をいただいた写真だけを出します',
  '名前は写真ごとに伏せられます',
  '公開の期限は設けていません。外す操作をするまで掲載され続けます',
  '外しても採用時のマイルは戻りません',
  '原本は公開しません。選んだ場所へ公開用画像を出します',
]

export function PublicationRules({ canEdit, busy, onOrder }: { canEdit: boolean; busy: boolean; onOrder: () => void }) {
  return <CreateSummaryCard title="出すときの決めごと" rows={[]} descriptionItems={PUBLICATION_RULES}>
    {<PermissionGatedButton allowed={canEdit} variant="secondary" disabled={busy} onClick={onOrder} busy={busy} busyLabel="処理中…"><ArrowUpDown size={16} aria-hidden="true" />並び順を変える</PermissionGatedButton>}
  </CreateSummaryCard>
}
