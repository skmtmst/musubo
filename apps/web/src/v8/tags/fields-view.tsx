'use client'
import { useEffect, useRef, useState } from 'react'
import { DetailContent, DetailFields, DetailInlineEdit } from '@/components/shared/detail-content'
import { RefreshCover } from '@/components/shared/refresh-cover'

import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import type { FriendFieldType } from '@line-crm/shared';
import { api } from '@/lib/api';
import { ListPageBody } from '@/components/templates';
import FolderPanel, { FolderPanelNote } from '@/components/shared/folder-panel';
import FolderAddDialog from '@/components/shared/folder-add-dialog';
import DetailPanel from '@/components/shared/detail-panel';
import InlineEdit from '@/components/shared/inline-edit';
import ConfirmDialog from '@/components/shared/confirm-dialog';
import Button from '@/components/shared/button';
import Select from '@/components/shared/select';
import SearchField from '@/components/shared/search-field';
import KpiCard from '@/components/shared/kpi-card';
import KpiBand from '@/components/shared/kpi-band';
import PageSizeSelect from '@/components/shared/page-size-select';
import { FIELD_TYPE_LABELS, destinationLabel, knownUsageCount } from '@/components/friend-fields/field-list';
import styles from './list.module.css';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import { ListToolbarFrame, ListToolbarRow, ListToolbarEnd, ListToolbarSearchSlot } from '@/components/shared/list-toolbar';
import Notice from '@/components/shared/notice';
import { EXTENDED_PAGE_SIZES as PAGE_SIZES } from '@/components/shared/page-size-options';
import type { useFieldsTab } from './use-fields-tab'
import { fieldTypeWord } from './fields-list-model'
import FieldsTable from './fields-table'

export default function FieldsView(model: ReturnType<typeof useFieldsTab>) {
  const { accountId, canEdit, host, explanation, error, actionError, setActionError, retryOrder, setRetryOrder, query, setQuery, type, setType, folderFilter, setFolderFilter, pageSize, setPageSize, pendingDelete, setPendingDelete, folders, folderDialog, setFolderDialog, deletingFolder, setDeletingFolder, folderBusy, folderError, setActiveFieldId, load, loadFolders, pageItems, activeField, activeFieldIndex, applyOrder, remove, removeFolder, kpis, folderRows, createButton, detailGuard } = model
  const [savedNotice, setSavedNotice] = useState('')
  useEffect(() => { setSavedNotice('') }, [accountId, activeField?.id])
  const currentScope = useRef({ accountId, fieldId: activeField?.id })
  currentScope.current = { accountId, fieldId: activeField?.id }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const deleteLockedReason = usePermissionLockReason(canEdit)
  const table = <FieldsTable {...model} />
  const operationHelp = canEdit ? `行の「…」に：編集・${host ? '配る' : '移行（種類を変える）'}・削除。並べ替えはつまんで上下（キーボードは上下キー）` : '行から中身を見られます。'
  const typeNote = host ? '情報欄のひな形を各アカウントへ配れます。種類と差し込みの名前は作ったあと変えられません。別の種類は新しいひな形を作ってください。' : '項目の種類を変えると、入っている値が変わることがあります。種類を変えるときは「移行」で事前に確かめてから変えます。'
  // いつも出す注意は「この画面の説明」の帯に入れる（絵の統括の  も帯1本）。行の操作は「…」の中に見えるので帯に重ねない。
  const typeNoteAsExplanation = Boolean(explanation)
  return (
    <>
      {host?.kpis ?? <KpiBand data-design="KPIs" className={styles.kpis}>
        {kpis.map((kpi) => (
          <KpiCard
            key={kpi.title}
            presentation="band"
            title={kpi.title}
            icon={<kpi.icon size={16} aria-hidden="true" />}
            value={kpi.value}
            unit={kpi.value == null ? '' : kpi.unit}
            detail={kpi.detail}
            help={kpi.help}
          />
        ))}
      </KpiBand>}

      <ListPageBody
        skeleton
        explanation={typeNoteAsExplanation ? typeNote : explanation ? operationHelp : undefined} listHelp={explanation ? undefined : operationHelp}
        folders={<>
          <FolderPanel
            createAction={createButton(true)}
            activeId={folderFilter}
            onSelect={setFolderFilter}
            onAddFolder={canEdit ? () => detailGuard.protect(() => { if (host) host.onAddFolder?.(); else setFolderDialog('new') }) : undefined}
            addFolderLabel="フォルダを追加"
            rows={folderRows}
          >
            <FolderPanelNote>フォルダを消しても、中の項目は未分類に残ります</FolderPanelNote>
            {folderError ? (
              <Notice tone="danger" className={styles.folderNoteNoticePlacement} >{folderError}
                <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => void loadFolders()}>もう一度</Button></Notice>
            ) : null}
          </FolderPanel>
        </>}
        folderNav={{ rows: folderRows, activeId: folderFilter, onSelect: setFolderFilter, createAction: createButton(false) }}
        toolbar={<>
          {typeNoteAsExplanation ? null : <Notice tone="info">{typeNote}</Notice>}
          <ListToolbarFrame><ListToolbarRow>
          <ListToolbarSearchSlot>
            <SearchField aria-label="項目名で探す" placeholder="項目名で探す" value={query} onChange={setQuery} onClear={() => setQuery('')} />
          </ListToolbarSearchSlot>
          <SaveErrorField names={["type"]}><Select
            aria-label="種類で絞り込む"
            width={119}
            value={type}
            onChange={(value) => setType(value as typeof type)}
            options={[
              { value: 'all', label: '種類：すべて' },
              ...(Object.keys(FIELD_TYPE_LABELS) as FriendFieldType[]).map((value) => ({ value, label: `種類：${fieldTypeWord(value)}` })),
            ]}
          /></SaveErrorField>
          <ListToolbarEnd><PageSizeSelect value={pageSize} onChange={(value) => setPageSize(value || 20)} options={PAGE_SIZES} label={null} /></ListToolbarEnd>
          </ListToolbarRow></ListToolbarFrame>
        </>}
      >
        {actionError ? (
          <Notice tone="danger" >{actionError}{retryOrder ? (
              <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => { const next = retryOrder; setRetryOrder(null); if (next) void applyOrder(next) }}>再試行</Button>
            ) : (
              <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => { setActionError(''); void load() }}>状態を確認する</Button>
            )}</Notice>
        ) : null}
        <RefreshCover refreshing={model.status === 'loading' && model.loaded}>{table}</RefreshCover>
      </ListPageBody>

      {/* 行の詳細パネル。名前はその場で直せる。 */}
      {detailGuard.dialog}
      <DetailPanel
        open={!host && activeField !== null}
        busy={detailGuard.busy}
        title={activeField?.name ?? ''}
        description={activeField ? `{{field.${activeField.fieldKey}}}・${fieldTypeWord(activeField.type)}` : undefined}
        onClose={() => setActiveFieldId(null)}
        hasPrev={activeFieldIndex > 0}
        hasNext={activeFieldIndex >= 0 && activeFieldIndex < pageItems.length - 1}
        onPrev={activeFieldIndex > 0 ? () => setActiveFieldId(pageItems[activeFieldIndex - 1].id) : undefined}
        onNext={activeFieldIndex >= 0 && activeFieldIndex < pageItems.length - 1 ? () => setActiveFieldId(pageItems[activeFieldIndex + 1].id) : undefined}
        actions={{ primary: (activeField ? <Button variant="primary" href={`/tags/fields/edit?id=${encodeURIComponent(activeField.id)}`}>編集する</Button> : null),
    secondary: (activeField && (knownUsageCount(activeField) ?? 0) > 0 ? <Button variant="secondary" href={`/tags/fields/migrate?id=${encodeURIComponent(activeField.id)}`}>移行する</Button> : null),
    menuItems: [], primaryAllowed: canEdit, secondaryAllowed: canEdit }}
      >
<DetailContent>
        {savedNotice ? <Notice tone="success" role="status">{savedNotice}</Notice> : null}
        {activeField ? (
          <DetailFields>
            <div>
              <dt>項目名</dt>
              <dd>
                <DetailInlineEdit {...detailGuard.editor} allowed={canEdit}
                    label="項目名"
                    value={activeField.name}
                    maxLength={40}
                    disabled={!accountId || activeField.isInherited}
                    onSave={async (next) => {
                      setSavedNotice('')
                      if (!accountId) throw new Error('no account')
                      const res = await api.friendFields.update(activeField.id, accountId, { name: next })
                      if (!res.success) throw new Error(res.error)
                      if (mounted.current && currentScope.current.accountId === accountId && currentScope.current.fieldId === activeField.id) {
                        setSavedNotice('友だち情報欄の名前を保存しました。')
                        void load()
                      }
                    }}
                  />
              </dd>
            </div>
            <div><dt>差し込み名</dt><dd>{`{{field.${activeField.fieldKey}}}`}</dd></div>
            <div><dt>種類</dt><dd>{fieldTypeWord(activeField.type)}</dd></div>
            <div><dt>入っている人</dt><dd>{knownUsageCount(activeField) === null ? emptyValue('unknown') : `${knownUsageCount(activeField)}人`}</dd></div>
            <div><dt>回答フォーム</dt><dd>{activeField.formUsageCount === undefined ? emptyValue('unknown') : `${activeField.formUsageCount}つ`}</dd></div>
            <div><dt>出す場所</dt><dd>{destinationLabel(activeField)}</dd></div>
          </DetailFields>
        ) : null}

</DetailContent>
</DetailPanel>

      {folderDialog ? (
        <FolderAddDialog
          kind="friend_field"
          folder={folderDialog === 'new' ? undefined : folderDialog}
          accountId={accountId}
          note="項目を分けてしまう箱です。消しても、入っていた項目は未分類として残ります。"
          placeholder="例：基本情報"
          onClose={() => setFolderDialog(null)}
          onAdded={() => { setFolderDialog(null); void loadFolders() }}
        />
      ) : null}

      <ConfirmDialog
        open={deletingFolder !== null}
        title={deletingFolder ? `フォルダ「${deletingFolder.name}」を削除しますか？` : 'フォルダを削除しますか？'}
        description="削除しても、中の項目は未分類に残ります。この操作は元に戻せません。"
        confirmLabel="フォルダを削除する"
        destructive
        busy={folderBusy}
        error={folderError || undefined}
        onCancel={() => { if (!folderBusy) setDeletingFolder(null) }}
        onConfirm={() => removeFolder()}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`項目「${pendingDelete?.name ?? ''}」を削除しますか？`}
        description="値が入っていない項目だけ削除できます。この操作は元に戻せません。"
        confirmLabel="削除する"
        destructive
        onCancel={() => { setPendingDelete(null); if (model.deleteNeedsReview) void load() }}
        confirmDisabled={!canEdit || model.deleteNeedsReview} confirmLockedReason={deleteLockedReason} confirmDisabledReason="閉じて最新の使用状況を確かめてください。"
        error={model.deleteError || undefined} onSuccess={() => setPendingDelete(null)} onConfirm={() => pendingDelete ? remove(pendingDelete) : false}
      />
    </>
  )
}
