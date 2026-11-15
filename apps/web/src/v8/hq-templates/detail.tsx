'use client'

/*
 * ★V8 統括のテンプレートの詳細（絵 V8.pen ・）。
 *
 * 店のテンプレートの詳細（src/v8/template-detail）と同じ枠（DetailFrame）・同じ CSS・同じ並び（本文・配った先・版の履歴・
 * 右の列の操作・このテンプレートについて・届き方）で組む。違いは「使っている所」の代わりの「配った先」と、帯の［配る］。
 * 配った先ごとの版（版3（いまの版）／新しい版を未配布）・版の履歴（比べる・この版に戻す）・今月送った数は API-18。
 * 読み書き（読み込み・複製・配る・版を比べる・戻す）は呼ぶ側（console.tsx）。ここは見せ方と押した知らせだけ。
 */
import { useState } from 'react'
import { ArrowLeft, ChevronDown, CircleAlert, Copy, GitCompare, LogIn, Pencil, RotateCcw, Send, Upload } from 'lucide-react'
import type { HqTemplateReceivedVersion, HqTemplateVersionComparison, HqTemplateVersionDisplay, MessageTemplateDefinition } from '@line-crm/shared'
import { templateKind } from '@line-crm/shared'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import Card, { CardHeader } from '@/components/shared/card'
import TagPill from '@/components/shared/tag-pill'
import { folderDisplayColor } from '@/components/shared/folder-dot'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import { DetailPage } from '@/components/templates/detail-page'
import { ChangeBox } from '@/v8/template-detail/public/detail/index'
import type { HqAccount, HqTemplateListItem, TemplateDetail } from '@/lib/hq-templates-api'
import { KIND_TABS, sentLabel } from './store-list'
import styles from '../template-detail/detail.module.css'
import { formatDate as polishFormatDate } from '@/lib/format'
import TruncatedText from '@/components/shared/truncated-text'
import { RowMenu } from '@/components/shared/row-actions'

import { emptyValue } from '@/components/shared/empty-value'
import { DetailLoading } from '@/components/templates/detail-page'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Notice from '@/components/shared/notice'
import { ListEmptyMessage } from '@/components/shared/list-state'

/** 「8月21日 18:02」（日本時間）。 */
function stamp(iso: string): string {
  return polishFormatDate(iso, { style: 'detail', fallback: '—' })
}

/** 本文の差し込み（{{name}} など）の名前。 */
function insertions(content: string): string[] {
  const names = new Set<string>()
  for (const match of content.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const key = match[1]
    names.add(key === 'name' ? '名前' : key.startsWith('date') ? '配信日' : key.startsWith('field.') ? '友だち情報' : key.startsWith('var.') ? '共通情報' : 'その他')
  }
  return [...names]
}

/** 版を比べるときの文（メッセージは本文、ほかの形は中身を行に分けた文）。 */
export function definitionText(definition: unknown): string {
  if (definition && typeof definition === 'object' && 'template' in definition) {
    const message = definition as MessageTemplateDefinition
    if (message.asset) return JSON.stringify(message.asset.payload, null, 1)
    if (message.template.questionJson) return message.template.questionJson
    return message.template.messageContent
  }
  return JSON.stringify(definition, null, 1)
}

/** いま配った先が使っている版（配布に成功した版のうち一番新しいもの）。 */
export function inUseVersionOf(versions: readonly HqTemplateVersionDisplay[] | null): HqTemplateVersionDisplay | null {
  return [...(versions ?? [])].filter((version) => !version.is_draft).sort((a, b) => b.version - a.version)[0] ?? null
}

/** 配った先の1行の版と状態（API-18 の received-versions）。 */
export function receivedLabels(row: HqTemplateReceivedVersion): { version: string; state: string } {
  const target = row.targetVersion
  if (target.status === 'undistributed' || target.version == null) return { version: '—', state: 'まだ配っていない' }
  return target.status === 'latest'
    ? { version: `版${target.version}（いまの版）`, state: '受け取り済み' }
    : { version: `版${target.version}`, state: '新しい版を未配布' }
}

export default function HqTemplateDetail({
  detail, row, accounts, folderName, folderColor, canEdit, busy, notices, versions, versionsError, received, onReloadVersions, onCompare, onRestore,
  onBack, onEdit, onDistribute, onDuplicate, onEnterAccount, onRemove,
}: {
  detail: TemplateDetail
  /** 一覧の行（配った先のアカウント名・数・中身の要約・今月送った数）。一覧に無いときは「—」。 */
  row?: HqTemplateListItem
  accounts: HqAccount[]
  folderName: string
  folderColor?: string | null
  canEdit: boolean
  busy: boolean
  notices?: React.ReactNode
  /** 版の履歴（API-18）。null は読み込み中。 */
  versions: HqTemplateVersionDisplay[] | null
  versionsError: boolean
  /** 配った先ごとの版（API-18）。null は読み込み中か読めなかった（その時は一覧の名前で出す）。 */
  received: HqTemplateReceivedVersion[] | null
  onReloadVersions: () => void
  onCompare: (from: number, to: number) => Promise<HqTemplateVersionComparison>
  onRestore: (version: number) => Promise<void>
  onBack: () => void
  onEdit: () => void
  onDistribute: () => void
  onDuplicate: () => void
  /** 配った先のアカウントに入る（店の画面へ切り替える）。 */
  onEnterAccount: (accountId: string) => void
  /** 右上の「…」の［削除する］（店の詳細と同じ置き場。絵 ）。渡さなければ「…」を出さない。 */
  onRemove?: () => void
}) {
  const [compare, setCompare] = useState<{ from: number; to: number; result: HqTemplateVersionComparison | null; error: string } | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState('')

  const definition = detail.definition as MessageTemplateDefinition
  const kind = 'template' in definition ? templateKind(definition) : 'message'
  const tag = 'tag' in detail.definition ? detail.definition.tag : null
  const tagFolder = tag && 'folders' in detail.definition ? detail.definition.folders.find((folder) => folder.id === tag.folderId) : null
  const tagColor = tagFolder ? folderDisplayColor(tagFolder) : folderColor
  const kindLabel = tag ? 'タグ' : KIND_TABS.find((tab) => tab.kind === kind)?.label ?? 'メッセージ'
  const content = 'template' in definition ? definition.template.messageContent : ''
  const summary = row?.content_summary ?? null
  const distributedNames = row?.distributed_account_names ?? []
  const distributedCount = row?.distributed_account_count ?? received?.filter((item) => item.targetVersion.status !== 'undistributed').length ?? 0
  const more = row?.distributed_account_more ?? 0
  const words = insertions(content)
  const text = kind === 'message' && content.trim() ? content : summary ? `［${kindLabel}］${summary}` : `［${kindLabel}］`
  const current = versions?.find((version) => version.is_current) ?? null
  const inUse = inUseVersionOf(versions)
  /* 直したあと配っていない：いまの版がまだどこにも配られていない（配った先はある）か、古い版のままの先がある。 */
  const outdatedCount = row?.outdated_account_count ?? received?.filter((item) => item.targetVersion.status === 'older').length ?? 0
  const unsentChanges = distributedCount > 0 && (outdatedCount > 0 || Boolean(current?.is_draft))
  const receivedRows = (received ?? []).filter((item) => item.targetVersion.status !== 'undistributed')

  const openCompare = (from: number, to: number) => {
    if (compare && compare.from === from && compare.to === to) { setCompare(null); return }
    setCompare({ from, to, result: null, error: '' })
    void onCompare(from, to).then(
      (result) => setCompare((now) => (now && now.from === from && now.to === to ? { ...now, result } : now)),
      (caught) => setCompare((now) => (now && now.from === from && now.to === to ? { ...now, error: japaneseDetailOf(caught) || '版を比べられませんでした。もう一度お試しください。' } : now)),
    )
  }
  const compareBox = compare ? (
    compare.error ? <Notice tone="danger" >{compare.error}</Notice>
      : !compare.result ? <ListEmptyMessage role="status">比べています…</ListEmptyMessage>
      : (
        <ChangeBox
          title={`比べる（版${compare.from} → 版${compare.to}）`}
          before={definitionText(compare.result.from.definition)}
          after={definitionText(compare.result.to.definition)}
        />
      )
  ) : null

  const side = (
    <div className={styles.side}>
      {(
        <div className={styles.sideActions}>
          <PermissionGatedButton allowed={canEdit} need="tenantWide" variant="secondary" href="/hq/broadcasts/new">
            <Send size={16} aria-hidden="true" />
            一括配信で使う
          </PermissionGatedButton>
          <PermissionGatedButton allowed={canEdit} need="tenantWide" variant="secondary" onClick={onDuplicate} disabled={busy}>
            <Copy size={16} aria-hidden="true" />
            複製する
          </PermissionGatedButton>
          {onRemove && canEdit ? <RowMenu appearance="box" label="そのほかの操作" menuLabel={`ひな形「${detail.template.name}」の操作`} items={[{ id: 'delete', label: '削除する', tone: 'danger' as const, onSelect: onRemove }]} /> : null}
        </div>
      )}
      <Card layout="vertical" contentPadding="var(--tpl-eds-about-pad)" gap="var(--tpl-eds-about-gap)" aria-label="このテンプレートについて">
        <CardHeader size="content" title="このテンプレートについて" />
        <dl className={styles.aboutList}>
          <div className={styles.aboutRow}><dt>種類</dt><dd>{kindLabel}</dd></div>
          <div className={styles.aboutRow}><dt>フォルダ</dt><dd>{folderName}</dd></div>
          <div className={styles.aboutRow}><dt>今月送った数</dt><dd title={row?.this_month_sent_count == null ? '今月送った数は、この種類では数えていません' : '配った先の合計'}>{sentLabel(row?.this_month_sent_count)}</dd></div>
          <div className={styles.aboutRow}><dt>差し込み</dt><dd title={words.join('・')}>{words.length > 0 ? words.join('・') : emptyValue('none')}</dd></div>
        </dl>
      </Card>
      <LinePreview accountName="公式アカウント" note="受け取る人のLINEでの見え方です。{ } の差し込みは、配った先のアカウントで送るときに、受け取る人ごとの値に変わります。">
        <LinePreviewMessage accountName="公式アカウント" avatar="公" time="18:00">{text}</LinePreviewMessage>
      </LinePreview>
    </div>
  )

  const backLink = <></>
  /* 配った先の名前（API-14 はアカウントの今の表示名）からアカウントを引く。同じ名前が無ければ、末尾が一致する1件だけ。 */
  const accountIdOf = (name: string) => {
    const exact = accounts.find((account) => account.name === name)
    if (exact) return exact.id
    const tail = accounts.filter((account) => account.name.endsWith(name))
    return tail.length === 1 ? tail[0].id : null
  }
  const shortName = (name: string) => name.replace(/^然\s*-NEN-\s*/, '')
  const enterButton = (accountId: string | null) => accountId
    ? <Button variant="text" onClick={() => onEnterAccount(accountId)} aria-label="このアカウントへ入る"><LogIn size={16} aria-hidden="true" />入る</Button>
    : <span className={styles.ghostSpacer} aria-hidden="true" />
  const creator = (version: HqTemplateVersionDisplay) => `${version.creator_name ?? emptyValue('unknown')}・${stamp(version.created_at)}`
  const sortedVersions = [...(versions ?? [])].sort((a, b) => b.version - a.version)

  const restore = async () => {
    if (restoreTarget === null || restoring) return
    setRestoring(true)
    setRestoreError('')
    try {
      await onRestore(restoreTarget)
      setRestoreTarget(null)
      setCompare(null)
    } catch (caught) {
      setRestoreError(japaneseDetailOf(caught) || 'この版に戻せませんでした。もう一度お試しください。')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className={styles.page} data-design-node="pQ4fH">
      <DetailPage layout="record-detail" contentPadding="var(--tpl-eds-content-pad)"
        title={detail.template.name}
        identity={backLink}
        help={[kindLabel, folderName, current?.creator_name ? `作った人 ${current.creator_name}` : null, `更新 ${stamp(detail.template.updated_at)}`].filter(Boolean).join('・')}
        summary={side}
        summaryLabel="LINE の見え方"
        summaryPreview={{ label: 'LINE の見え方', title: 'LINE の見え方' }}
      >
        {canEdit ? null : <div className={styles.roBand}><ReadOnlyNotice role="note">閲覧のみで見ています。編集・配る操作は統括の管理者に頼んでください。</ReadOnlyNotice></div>}
        {notices}
        {canEdit ? (
          <Notice tone="warn" role="status" icon={<CircleAlert size={20} aria-hidden="true" />}
            heading={unsentChanges ? '配っていない変更があります' : distributedCount > 0 ? '直したら、配ると新しい版になります' : 'まだ配っていません'}
            action={<>
              {unsentChanges && inUse && current && inUse.version !== current.version ? (
                <Button variant="secondary" onClick={() => openCompare(inUse.version, current.version)} aria-pressed={compare?.from === inUse.version && compare.to === current.version}>
                  <GitCompare size={16} aria-hidden="true" />比べる
                </Button>
              ) : null}
              <Button variant="primary" onClick={onDistribute} disabled={busy} aria-label={`${detail.template.name}を配る`}>
                <Upload size={16} aria-hidden="true" />配る
              </Button>
            </>}>
            {distributedCount > 0
              ? `配ると、配った ${distributedCount} アカウントのテンプレートが新しい版になります（各アカウントで使っている所はそのアカウントの決まりで切り替わります）`
              : '「配る」で、選んだアカウントのテンプレートに届きます'}
          </Notice>
        ) : null}
        {compare && inUse && current && compare.from === inUse.version && compare.to === current.version ? compareBox : null}

        <Card layout="vertical" contentPadding="var(--tpl-eds-card-pad)" gap="var(--tpl-eds-card-gap)" aria-label="本文">
          <CardHeader size="content" title={`${kind === 'message' ? '本文' : '中身'}${current?.is_draft && distributedCount > 0 ? '（下書き）' : ''}`} meta={kind === 'message' ? '{ } は差し込み。受け取る人ごとに変わります。' : summary ?? '中身の要約を読めませんでした'} action={canEdit ? <Button variant="secondary" onClick={onEdit} disabled={busy}><Pencil size={16} aria-hidden="true" />編集する</Button> : undefined} />
          <div className={styles.bodyBox}>{tag ? <TagPill name={tag.name} color={tagColor} /> : kind === 'message' ? content : `［${kindLabel}］${summary ?? ''}`}</div>
        </Card>

        <Card layout="vertical" contentPadding="var(--tpl-eds-card-pad)" gap="var(--tpl-eds-card-gap)" aria-label="配った先">
          <CardHeader size="content" title="配った先" meta={distributedCount > 0
            ? `${distributedCount} アカウントに配りました。新しい版を配ると、${distributedCount} アカウントのテンプレートが新しい版になります。`
            : 'まだどのアカウントにも配っていません。配ると、ここに並びます。'} />
          {receivedRows.length > 0 ? receivedRows.map((item) => {
            const labels = receivedLabels(item)
            return (
              <div key={item.accountId} className={styles.usageRow}>
                <span className={styles.usageKind} title={item.accountName}>{shortName(item.accountName)}</span>
                <span className={styles.usageNameQuiet} title={item.accountName}>{item.accountName}</span>
                <span className={styles.usageVersion} title={labels.version}>{labels.version}</span>
                <span className={`${styles.usageState} ${styles.usageStateWide}`} title={labels.state}>{labels.state}</span>
                {enterButton(accounts.some((account) => account.id === item.accountId) ? item.accountId : null)}
              </div>
            )
          }) : distributedNames.length > 0 ? (
            <>
              {distributedNames.map((name) => (
                <div key={name} className={styles.usageRow}>
                  <span className={styles.usageKind} title={name}>{shortName(name)}</span>
                  <span className={styles.usageNameQuiet} ><TruncatedText value={String(name ?? '')} /></span>
                  <span className={styles.usageVersion}>—</span>
                  <span className={`${styles.usageState} ${styles.usageStateWide}`}>受け取り済み</span>
                  {enterButton(accountIdOf(name))}
                </div>
              ))}
              {more > 0 ? <div className={styles.moreRow}><ListEmptyMessage as="span">{`ほか ${more} アカウント`}</ListEmptyMessage></div> : null}
            </>
          ) : <ListEmptyMessage>まだ配っていません</ListEmptyMessage>}
          <div className={styles.moreRow}>
            <PermissionGatedButton allowed={canEdit} need="tenantWide" variant="text" onClick={onDistribute} disabled={busy}><ChevronDown size={16} aria-hidden="true" />配る先を変える</PermissionGatedButton>
          </div>
        </Card>

        <Card layout="vertical" contentPadding="var(--tpl-eds-card-pad)" gap="var(--tpl-eds-card-gap)" aria-label="版の履歴">
          <CardHeader size="content" title="版の履歴" meta="戻すと、その版を下書きとして作り直します。配るまで配った先は変わりません" />
          {versions === null && !versionsError ? <DetailLoading /> : versionsError ? (
            <div className={styles.versionError}>
              <p className={styles.errorText}>版の履歴を読み込めませんでした。もう一度お試しください。</p>
              <Button variant="secondary" onClick={onReloadVersions}>もう一度読み込む</Button>
            </div>
          ) : (
            <>
              {sortedVersions.map((version) => {
                const isInUse = inUse?.version === version.version
                const label = version.is_current
                  ? (version.is_draft ? '下書き（まだ配っていない）' : 'いまの版')
                  : isInUse ? 'いま使っている版' : version.is_draft ? '配っていない版' : '前の版'
                return (
                  <div key={version.id} className={version.is_current && version.is_draft ? styles.versionDraft : isInUse ? styles.versionInUse : styles.versionPast}>
                    <span className={styles.versionNum}>{`版${version.version}`}</span>
                    <div className={styles.versionText}>
                      <p className={styles.versionLabel}>{label}</p>
                      <p className={styles.versionMeta}>{creator(version)}</p>
                    </div>
                    {version.is_current ? (
                      inUse && inUse.version !== version.version ? (
                        <div className={styles.versionActions}>
                          <Button variant="secondary" onClick={() => openCompare(inUse.version, version.version)}><GitCompare size={16} aria-hidden="true" />いまの版と比べる</Button>
                        </div>
                      ) : null
                    ) : !isInUse ? (
                      <div className={styles.versionActions}>
                        {current ? <Button variant="secondary" onClick={() => openCompare(version.version, current.version)}><GitCompare size={16} aria-hidden="true" />比べる</Button> : null}
                        <PermissionGatedButton allowed={canEdit} need="tenantWide" variant="secondary" disabled={busy} onClick={() => { setRestoreError(''); setRestoreTarget(version.version) }}><RotateCcw size={16} aria-hidden="true" />この版に戻す</PermissionGatedButton>
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {compare && !(inUse && current && compare.from === inUse.version && compare.to === current.version) ? compareBox : null}
            </>
          )}
        </Card>
      </DetailPage>

      <ConfirmDialog
        open={restoreTarget !== null}
        title={`版${restoreTarget ?? ''}の内容で下書きを作り直しますか？`}
        description="過去の版は変わりません。その中身で新しい版を作ります。配るまで、配った先のアカウントは今の版のままです。"
        confirmLabel="この版に戻す"
        busy={restoring}
        error={restoreError || undefined}
        onConfirm={() => restore()}
        onCancel={() => {
          if (restoring) return
          setRestoreTarget(null)
          setRestoreError('')
        }}
      />
    </div>
  )
}
