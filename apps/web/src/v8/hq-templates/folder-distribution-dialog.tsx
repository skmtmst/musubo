'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import type { HqTemplateFolder } from '@line-crm/shared'
import type { HqAccount, HqTemplate } from '@/lib/hq-templates-api'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import StatusBadge from '@/components/shared/status-badge'
import TagPill from '@/components/shared/tag-pill'
import { folderDisplayColor } from '@/components/shared/folder-dot'
import DistributionAccountPicker from './distribution-account-picker'
import { ALL_ACCOUNTS, type useDistributionFolders } from './distribution-accounts'
import styles from './folder-distribution-dialog.module.css'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { formatNumber } from '@/lib/format'

export function distributionKind(row: HqTemplate) {
  if (row.template_type === 'template' && (row.kind ?? 'message') === 'message' && row.content_summary) return row.content_summary.replace(/\s+\d+$/u, '')
  return row.template_type === 'template' ? ({ message: 'メッセージ', carousel: 'カルーセル', rich_message: 'リッチメッセージ', rich_video: 'リッチビデオ', question: '質問', coupon: 'クーポン', research: 'リサーチ' }[row.kind ?? 'message'])
    : ({ tag: 'タグ', rich_menu: 'リッチメニュー', form: '回答フォーム', scenario: 'シナリオ' }[row.template_type])
}
export default function FolderDistributionDialog({ name, templates, templateFolders = [], accounts, accountFolders, busy, error, onCancel, onConfirm }: {
  name: string; templates: HqTemplate[]; templateFolders?: HqTemplateFolder[]; accounts: HqAccount[]; accountFolders: ReturnType<typeof useDistributionFolders>; busy: boolean; error?: string
  onCancel: () => void; onConfirm: (templates: HqTemplate[], ids: string[]) => void
}) {
  const [picked, setPicked] = useState(templates.map((row) => row.id))
  const [selected, setSelected] = useState<string[]>([])
  const [accountFilter, setAccountFilter] = useState(ALL_ACCOUNTS)
  const [accountSearch, setAccountSearch] = useState('')
  return <Dialog open designNode="JSirC" designWidth={720} title={`フォルダ「${name}」の ${formatNumber(templates.length)} 件を配る`}
    description="フォルダの中のひな形をまとめて、選んだアカウントへ配ります。"
    busy={busy} error={error} onCancel={onCancel}
    designHeaderPadding="24px 24px 8px" designContentPadding="8px 24px 20px"
    footer={<DialogActions>
      <Button disabled={busy} onClick={onCancel}>キャンセル</Button>
      <Button variant="primary" disabled={busy || !picked.length || !selected.length} disabledReason={!picked.length ? '配るテンプレートを選んでください。' : !selected.length ? '配るアカウントを選んでください。' : undefined} onClick={() => onConfirm(templates.filter((row) => picked.includes(row.id)), selected)}>
        <Send size={16} aria-hidden="true" />{`${formatNumber(picked.length)} 件を ${selected.length} アカウントへ配る`}
      </Button>
    </DialogActions>}
  >
    <div className={styles.sections}>
      {/* 絵 W2GYgL：配るテンプレートはチェックの一覧（種類の札つき）、配る先はフォルダの列＋アカウントのチェックの一覧。 */}
      <section className={styles.section} aria-label="配るテンプレート">
        <div className={styles.heading}><strong>配るテンプレート</strong><span>{`${picked.length} / ${formatNumber(templates.length)} 件を選択`}</span></div>
        <div className={styles.list}>
          {templates.map((row) => <div key={row.id} className={styles.row}>
            <SaveErrorField names={["picked"]}><Checkbox checked={picked.includes(row.id)} disabled={busy}
              onCheckedChange={(checked) => setPicked((current) => checked ? [...current, row.id] : current.filter((id) => id !== row.id))}>{row.template_type === 'tag' ? <TagPill name={row.name} color={(() => { const folder = templateFolders.find((item) => item.id === row.folder_id); return folder ? folderDisplayColor(folder) : undefined })()} size="sm" /> : row.name}</Checkbox></SaveErrorField>
            <StatusBadge size="compact" tone="neutral" dot={false}>{distributionKind(row)}</StatusBadge>
          </div>)}
        </div>
      </section>
      <section className={styles.section} aria-label="配る先">
        <div className={styles.heading}><strong>配る先</strong><span>{`${selected.length} アカウントを選択`}</span></div>
        <DistributionAccountPicker compact selectAll showCount={false} accounts={accounts} folders={accountFolders} selected={selected} onChange={setSelected}
          filter={accountFilter} onFilter={setAccountFilter} search={accountSearch} onSearch={setAccountSearch} busy={busy} />
      </section>
      <p className={styles.note}>同じ名前のひな形があるアカウントは、配布方法（上書き・新しく作る）を次の確認で選べます。</p>
    </div>
  </Dialog>
}
