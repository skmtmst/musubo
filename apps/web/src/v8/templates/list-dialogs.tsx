'use client'
import { DetailContent, DetailField, DetailInlineEdit } from '@/components/shared/detail-content'
import type { useInlineDetailGuard } from '@/components/shared/use-inline-detail-guard'
import type { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'

import type { BroadcastBubble } from '@/lib/api'
import type { UsageRow } from './words'


import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary, { type OperationAccountTarget } from '@/components/shared/operation-target-summary'
import DetailPanel from '@/components/shared/detail-panel'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import DialogChoiceCards from '@/components/shared/dialog-choice-cards'
import { emptyValue } from '@/components/shared/empty-value'
import FolderAddDialog from '@/components/shared/folder-add-dialog'
import FolderSelect from '@/components/shared/folder-select'
import InlineEdit from '@/components/shared/inline-edit'
import Link from '@/components/shared/list-navigation'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { withViewTransition } from '@/components/shared/view-transition'
import { type TemplateQuestion } from '@/lib/api'
import type { Folder } from '@line-crm/shared'
import { List,SquareArrowOutUpRight } from 'lucide-react'
import type { Dispatch,JSX,SetStateAction } from 'react'
import TemplateDeleteDialog from './delete-dialog'
import { exampleHref,type TemplateExample } from './examples'
import { BLOCKED_ROWS_SHOWN,KIND_CARDS,PendingDelete,Template,latestContentOf,publishStateOf } from './list-model'
import styles from './list.module.css'
import { DELETE_UNUSED_DESCRIPTION,blockedDeleteDescription,type UsageDetail } from './words'
import StatusBadge from '@/components/shared/status-badge'

const PUBLISH_TONE = { live: 'success', changes: 'warning', draft: 'neutral' } as const

type RenderTemplateDialogsContext = {
  moveGuard: ReturnType<typeof useUnsavedGuard>
  detailGuard: ReturnType<typeof useInlineDetailGuard>
  folderDeleteAccounts: OperationAccountTarget[]
  cancelFolderDelete: () => void
  deleteAccounts: OperationAccountTarget[]
  bulkDeleteAccounts: OperationAccountTarget[]
  activeFolderName: string | null
  activeIndex: number
  activeTemplate: Template | null
  blockedDelete: PendingDelete | null
  blockedLoadError: boolean
  blockedLoading: boolean
  blockedRows: UsageRow[]
  blockedTotal: number
  blockedUsage: UsageDetail | null
  bulkDeleteError: string
  bulkDeleting: boolean
  canMutateTemplates: boolean
  confirmDelete: () => Promise<void>
  deleteError: string
  deleting: boolean
  deletingFolder: Folder | null
  detailHref: (t: Template) => string
  editHref: (t: Template) => string
  editingFolder: Folder | null
  examples: TemplateExample[] | null
  examplesError: boolean
  folderBusy: boolean
  folderDialogOpen: boolean
  folderError: string
  folders: Folder[]
  handleDelete: (t: Template) => void
  isTemplateSection: boolean
  loadFolders: () => Promise<void>
  moveDraft: string
  moveError: string
  moveIds: string[] | null
  moving: boolean
  navItems: Template[]
  openMove: (ids: string[]) => void
  panelDetail: { detail: { id: string; accountId: string | null; name: string; category: string; messageType: string; messageContent: string; messageBubbles?: BroadcastBubble[] | null; question: TemplateQuestion | null; questionStatus: "draft" | "published"; folderId: string | null; carouselActions: unknown | null; carouselTapLimitMode: string; carouselTapLimitText: string | null; usedBy: { autoReplies: Array<{ id: string; keyword: string; matchType: "exact" | "contains"; lineAccountId: string | null; templateVersion: number | null; }>; automations: Array<{ id: string; name: string; eventType: string; }>; scenarioSteps: Array<{ scenarioId: string; scenarioName: string; stepId: string; stepOrder: number; displayOrder?: number; templateVersion: number | null; }>; reminderSteps: Array<{ reminderId: string; reminderName: string; stepId: string; }>; richMenuAreas: Array<{ groupId: string; groupName: string; pageName: string; areaId: string; label: string | null; }>; trackedLinks: Array<{ id: string; name: string; }>; broadcasts: Array<{ broadcastId: string; title: string; status: string; scheduledAt: string | null; templateVersionNumber: number | null; referenceMode: "fixed" | "latest"; }>; reminderEnrollments?: Array<{ enrollmentId: string; reminderId: string; reminderName: string; versionNumber: number; enrollmentStatus: string; targetDate: string; }>; }; createdAt: string; updatedAt: string; hasDraft: boolean; publishedVersion: number; publishedAt: string | null; draftRevision: number; } | null; error: string; loading?: boolean; publishing: boolean; publish: () => Promise<void>; reload?: () => Promise<void>; }
  panelMove: boolean
  panelUsageRows: UsageRow[]
  pendingBulkDelete: Template[] | null
  pendingDelete: PendingDelete | null
  pickerOpen: boolean
  removeFolder: () => Promise<void>
  renameTemplate: (t: Template, next: string) => Promise<void>
  router: ReturnType<typeof import('@/components/shared/list-navigation').useListNavigationRouter>
  runBulkDelete: () => Promise<void>
  runDuplicate: (duplicateTarget: Template) => Promise<void>
  runMove: () => Promise<void>
  savedMenu: JSX.Element
  selectedAccountId: string | null
  setActiveId: Dispatch<SetStateAction<string | null>>
  setBlockedDelete: Dispatch<SetStateAction<PendingDelete | null>>
  setBlockedUsage: Dispatch<SetStateAction<UsageDetail | null>>
  setBulkDeleteError: Dispatch<SetStateAction<string>>
  setDeleteError: Dispatch<SetStateAction<string>>
  setDuplicateError: (message: string | null) => void
  setEditingFolder: Dispatch<SetStateAction<Folder | null>>
  setExamplesRetry: Dispatch<SetStateAction<number>>
  setFolderDialogOpen: Dispatch<SetStateAction<boolean>>
  setFolderError: Dispatch<SetStateAction<string>>
  setMoveDraft: Dispatch<SetStateAction<string>>
  setMoveError: Dispatch<SetStateAction<string>>
  setMoveIds: Dispatch<SetStateAction<string[] | null>>
  setPanelMove: Dispatch<SetStateAction<boolean>>
  setPendingBulkDelete: Dispatch<SetStateAction<Template[] | null>>
  setPendingDelete: Dispatch<SetStateAction<PendingDelete | null>>
  setPickerOpen: Dispatch<SetStateAction<boolean>>
  templates: Template[]
}

export function renderTemplateDialogs({ moveGuard, folderDeleteAccounts, cancelFolderDelete, deleteAccounts, bulkDeleteAccounts, activeFolderName, activeIndex, activeTemplate, blockedDelete, blockedLoadError, blockedLoading, blockedRows, blockedTotal, blockedUsage, bulkDeleteError, bulkDeleting, canMutateTemplates, confirmDelete, deleteError, deleting, deletingFolder, detailHref, editHref, editingFolder, examples, examplesError, folderBusy, folderDialogOpen, folderError, folders, handleDelete, isTemplateSection, loadFolders, moveDraft, moveError, moveIds, moving, navItems, openMove, panelDetail, panelMove, panelUsageRows, pendingBulkDelete, pendingDelete, pickerOpen, removeFolder, renameTemplate, router, runBulkDelete, runDuplicate, runMove, savedMenu, selectedAccountId, setActiveId, setBlockedDelete, setBlockedUsage, setBulkDeleteError, setDeleteError, setDuplicateError, setEditingFolder, setExamplesRetry, setFolderDialogOpen, setFolderError, setMoveDraft, setMoveError, setMoveIds, setPanelMove, setPendingBulkDelete, setPendingDelete, setPickerOpen, templates, detailGuard }: RenderTemplateDialogsContext) {
  return ((
    <>
      {savedMenu}
      <Dialog
        open={pickerOpen}
        title="どの種類を作りますか"
        designNode="I4jUUW"
        designWidth={960}
        designTop={200}
        designHeaderPadding="24px 24px 0"
        designHeaderHeight={48}
        onCancel={() => setPickerOpen(false)}
        footer={<></>}
      >
        <div className={styles.picker}>
          <DialogChoiceCards choices={KIND_CARDS.map(card => ({
            key: card.key, title: card.title, icon: <card.icon size={16} />,
            description: card.desc, notes: [card.useFor, card.cannot], href: card.href,
          }))} columns={4} onChoose={href => { setPickerOpen(false); router.push(href) }} />
          {examplesError?<ListState kind="error" title="見本を読み込めませんでした" onRetry={()=>setExamplesRetry(value=>value+1)}/>:null}
          {examples && examples.length > 0 ? (
            <section className={styles.examples} aria-label="見本から作る">
              <h3 className={styles.examplesTitle}>見本から作る</h3>
              <div className={styles.exampleRow}>
                {examples.slice(0, 4).map((example) => (
                  <button
                    key={example.id}
                    type="button"
                    className={styles.exampleCard}
                    title={example.body}
                    onClick={() => {
                      setPickerOpen(false)
                      router.push(exampleHref(example))
                    }}
                  >
                    <span className={styles.exampleName}>{example.name}</span>
                    {/* 見本はどれも文字のメッセージ（口が返すのは名前と本文だけ）。 */}
                    <span className={styles.exampleKind}>メッセージ</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <div className={styles.pickerFooter}>
            <Button type="button" variant="secondary" onClick={() => setPickerOpen(false)}>
              キャンセル
            </Button>
          </div>
        </div>
      </Dialog>

      {/*
        削除の確認窓（`V6JFnd`：使っていないテンプレート）。
        危ないボタンは左端、キャンセルは真ん中（V8 の窓の決まり）。
      */}
      <TemplateDeleteDialog
        targetAccounts={deleteAccounts}
        open={pendingDelete !== null}
        title={`「${pendingDelete?.item.name ?? ''}」を削除しますか？`}
        description={DELETE_UNUSED_DESCRIPTION}
        busy={deleting} error={deleteError}
        confirmDisabled={pendingDelete !== null && pendingDelete.accountId !== selectedAccountId}
        confirmLockedReason={canMutateTemplates ? undefined : 'テンプレートを変更する権限がありません。'}
        onConfirm={() => confirmDelete()}
        onCancel={() => { if (!deleting) { setPendingDelete(null); setDeleteError('') } }}
      />

      {/* まとめて削除の確認窓。対象は「使っていない」ものだけ。 */}
      <ConfirmDialog
        open={pendingBulkDelete !== null}
        title={`${pendingBulkDelete?.length ?? 0} 件のテンプレートを削除しますか？`}
        description="どれも使われていないので、他の画面の動きは止まりません。すでに送ったメッセージは残ります。この操作は取り消せません。"
        confirmLabel="まとめて削除する"
        destructive
        busy={bulkDeleting}
        confirmLockedReason={canMutateTemplates ? undefined : 'テンプレートを変更する権限がありません。'}
        error={bulkDeleteError}
        onConfirm={() => runBulkDelete()}
        onCancel={() => {
          if (bulkDeleting) return
          setPendingBulkDelete(null)
          setBulkDeleteError('')
        }}
      >
        <OperationTargetSummary accounts={bulkDeleteAccounts} showAccountCount={bulkDeleteAccounts.length > 1} />
      </ConfirmDialog>

      {/*
        削除できない窓（`Z0g3si`：使っている所がある）。
        中身は usage 口で取り、差し替え先へのリンクを並べる。
      */}
      <Dialog
        open={blockedDelete !== null}
        title={`「${blockedDelete?.item.name ?? ''}」はまだ消せません`}
        description={blockedDelete ? blockedDeleteDescription(blockedDelete.item.usageCount) : undefined}
        designNode="Z0g3si"
        onCancel={() => {
          setBlockedDelete(null)
          setBlockedUsage(null)
        }}
        footer={blockedDelete ? (
          <DialogActions>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setBlockedDelete(null)
                setBlockedUsage(null)
              }}
            >
              閉じる
            </Button>
            <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  const target = blockedDelete.item
                  setBlockedDelete(null)
                  setBlockedUsage(null)
                  return withViewTransition(() => router.push(detailHref(target)))
                }} busyLabel="処理中…"
              >
                <List size={16} aria-hidden="true" />
                使っている所をすべて見る
              </Button>
          </DialogActions>
        ) : undefined}
      >
        {blockedLoading ? (
          <p className={styles.faintText}>使用先を読み込んでいます…</p>
        ) : blockedLoadError ? (
          // 消してよいか分からないのに消させない。閉じて読み直すだけ。
          <Notice tone="danger" className={styles.alertTextNoticePlacement} >使っている所を確認できませんでした。閉じてから、もう一度お試しください。</Notice>
        ) : blockedUsage ? (
          <div className={styles.usageList}>
            <ul>
              {blockedRows.slice(0, BLOCKED_ROWS_SHOWN).map((row) => (
                <li key={row.key} className={styles.usageRow}>
                  <span className={styles.usageKind}>{row.kind}</span>
                  <span className={styles.usageName} title={row.status ? `${row.name}（${row.status}）` : row.name}>{row.name}</span>
                  {row.href ? (
                    <Link href={row.href} className={styles.usageOpen}>
                      <SquareArrowOutUpRight size={16} aria-hidden="true" />
                      開いて差し替える
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
            {blockedTotal > BLOCKED_ROWS_SHOWN ? (
              <p className={styles.usageMore}>{`ほか ${blockedTotal - BLOCKED_ROWS_SHOWN} か所`}</p>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      {/* フォルダへ移すの窓。パネルで選ぶ1件のときは出さない。 */}
      <ConfirmDialog
        open={moveIds !== null && !panelMove}
        title={
          moveIds && moveIds.length === 1
            ? `「${templates.find((t) => t.id === moveIds[0])?.name ?? ''}」のフォルダを移す`
            : `${moveIds?.length ?? 0} 件のテンプレートをフォルダへ移す`
        }
        description="移動先のフォルダを選んでください。「未分類」を選ぶとフォルダから外れます。"
        confirmLabel="移動する" busyLabel="移動中…"
        busy={moving}
        error={moveError}
        onConfirm={() => runMove()}
        onCancel={() => {
          if (moving) return
          moveGuard.guarded(() => { setMoveIds(null); setMoveError('') })
        }}
      >
        <div className={styles.moveBody}>
          <span className={styles.moveLabel}>移動先のフォルダ</span>
          <SaveErrorField names={["moveDraft","move_draft"]}><FolderSelect
            aria-label="移動先のフォルダ"
            size="full"
            value={moveDraft}
            onChange={(value) => setMoveDraft(value)}
            disabled={moving}
            folders={folders.map((folder) => ({ value: folder.id, label: folder.name }))}
          /></SaveErrorField>
        </div>
      </ConfirmDialog>

      {/* 複製の確認窓。コピーは下書きで作る（公開は別の操作）。 */}
      <></>

      {folderDialogOpen && (
        <FolderAddDialog
          kind="template"
          accountId={selectedAccountId}
          note="テンプレートを分けてしまう箱です。削除しても、中のテンプレートは未分類に残ります。"
          placeholder="例：01_定期便"
          onClose={() => setFolderDialogOpen(false)}
          onAdded={() => { setFolderDialogOpen(false); void loadFolders() }}
        />
      )}

      {editingFolder && (
        <FolderAddDialog
          kind="template"
          folder={editingFolder}
          accountId={selectedAccountId}
          note="テンプレートを分けてしまう箱です。削除しても、中のテンプレートは未分類に残ります。"
          placeholder="例：01_定期便"
          onClose={() => setEditingFolder(null)}
          onAdded={() => { setEditingFolder(null); void loadFolders() }}
        />
      )}

      {/* フォルダを消す前に、中身がどうなるかを本文で読ませる。 */}
      <ConfirmDialog
        open={deletingFolder !== null}
        title={`フォルダ「${deletingFolder?.name ?? ''}」を削除しますか？`}
        description={`削除しても、中のテンプレートは未分類に残ります。いまこのフォルダに入っているのは${
          deletingFolder ? templates.filter((t) => t.folderId === deletingFolder.id).length : 0
        } 件です。`}
        confirmLabel="削除する"
        destructive
        busy={folderBusy}
        error={folderError || undefined}
        onCancel={cancelFolderDelete}
        onConfirm={() => removeFolder()}
      ><OperationTargetSummary accounts={folderDeleteAccounts} externalTarget={deletingFolder?.accountId === null ? { label: 'フォルダの対象', name: '共通（全アカウント）' } : undefined} /></ConfirmDialog>

      {/* 行の詳細パネル。一覧は左に見えたまま。 */}
      {activeTemplate && isTemplateSection ? (
        <DetailPanel
          open
          busy={detailGuard.busy}
          title={activeTemplate.name}
          description={activeFolderName ?? undefined}
          onClose={() => setActiveId(null)}
          hasPrev={activeIndex > 0}
          hasNext={activeIndex >= 0 && activeIndex < navItems.length - 1}
          onPrev={() => setActiveId(navItems[activeIndex - 1]?.id ?? null)}
          onNext={() => setActiveId(navItems[activeIndex + 1]?.id ?? null)}
          actions={{ primary: ((panelMove ? <Button type="button" variant="primary" disabled={moving} busy={moving} onClick={() => detailGuard.protect(() => { void runMove() })} busyLabel="移動中…">
                    移動する
                  </Button> : null)) ?? (<Button type="button" variant="primary" onClick={() => requestUnsavedAction(() => detailGuard.protect(() => withViewTransition(() => router.push(detailHref(activeTemplate)))))} busyLabel="移動中…">
                詳細を見る
              </Button>),
    secondary: (<Button type="button" variant="secondary" onClick={() => requestUnsavedAction(() => detailGuard.protect(() => withViewTransition(() => router.push(editHref(activeTemplate)))))} busyLabel="移動中…">
                  編集する
                </Button>),
    menuItems: [...(panelDetail.detail?.hasDraft ? [{ allowed: canMutateTemplates, id: 'detail-0', label: "公開する", disabled: panelDetail.publishing, onSelect: () => requestUnsavedAction(() => detailGuard.protect(() => { void panelDetail.publish() })) }] : []),
        ...([{ allowed: canMutateTemplates, id: 'detail-1', label: "複製する", onSelect: () => requestUnsavedAction(() => detailGuard.protect(() => {
                    setDuplicateError('');
                    void runDuplicate(activeTemplate);
                })) }]),
        ...([{ allowed: canMutateTemplates, id: 'detail-2', label: "フォルダへ移す", onSelect: () => requestUnsavedAction(() => detailGuard.protect(() => openMove([activeTemplate.id]))) }]),
        ...([{ allowed: canMutateTemplates, id: 'detail-3', label: "削除する", onSelect: () => requestUnsavedAction(() => detailGuard.protect(() => handleDelete(activeTemplate))), tone: 'danger' as const }])], primaryAllowed: !panelMove || canMutateTemplates, secondaryAllowed: canMutateTemplates }}
         status={<StatusBadge tone={PUBLISH_TONE[publishStateOf(activeTemplate).tone]}>{publishStateOf(activeTemplate).label}</StatusBadge>}>
<DetailContent>
          <div className={styles.panelBody}>
            <DetailField label="名前"> <DetailInlineEdit {...detailGuard.editor} allowed={canMutateTemplates}
                value={activeTemplate.name}
                label="テンプレートの名前"
                maxLength={100}
                onSave={(next) => renameTemplate(activeTemplate, next)}
              /> </DetailField>
            <DetailField label="中身の抜粋">
              {latestContentOf(activeTemplate).slice(0, 120)}
              {latestContentOf(activeTemplate).length > 120 ? '…' : ''}
             </DetailField>

            <DetailField label="使っている所">
              {typeof activeTemplate.usageCount !== 'number'
                ? '使っている所を確認できません'
                : activeTemplate.usageCount === 0
                  ? emptyValue('none')
                  : `${activeTemplate.usageCount}か所`}
             </DetailField>
            {panelDetail.error ? (
              <Notice
                tone="danger"
                action={panelDetail.reload ? (
                  <Button type="button" variant="secondary" size="compact" busy={panelDetail.loading} busyLabel="読み込み中…" onClick={() => void panelDetail.reload?.()}>
                    もう一度読み込む
                  </Button>
                ) : undefined}
              >
                {panelDetail.error}
              </Notice>
            ) : null}
            {panelUsageRows.length > 0 ? <div className={styles.usageList}><ul>
              {panelUsageRows.map((row) => <li key={row.key} className={styles.usageRow}>
                <span className={styles.usageKind}>{row.kind}</span>
                <span className={styles.usageName}>{row.name}</span>
                {row.href ? <Link href={row.href} className={styles.usageOpen}>開いて差し替える</Link> : null}
              </li>)}
            </ul></div> : null}
            {panelMove ? (
              <>
                <p className={styles.panelLabel}>移動先のフォルダ</p>
                <div className={styles.moveBody}>
                  <SaveErrorField names={["moveDraft","move_draft"]}><FolderSelect
                    aria-label="移動先のフォルダ"
                    size="full"
                    value={moveDraft}
                    onChange={(value) => setMoveDraft(value)}
                    disabled={moving}
                    folders={folders.map((folder) => ({ value: folder.id, label: folder.name }))}
                  /></SaveErrorField>

                </div>
                {moveError ? <Notice tone="danger" className={styles.alertTextNoticePlacement} >{moveError}</Notice> : null}
              </>
            ) : null}
          </div>

</DetailContent>
</DetailPanel>
      ) : null}
    </>
  ))
}
