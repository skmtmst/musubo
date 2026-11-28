'use client'

import Button from '@/components/shared/button'
import DateField from '@/components/shared/date-field'
import DateTimeField from '@/components/shared/date-time-field'
import FolderSelect,{ folderById,folderCreator } from '@/components/shared/folder-select'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { api,type CommonVarDetail } from '@/lib/api'
import type { Folder } from '@line-crm/shared'
import type { Dispatch,SetStateAction } from 'react'
import styles from './edit.module.css'

import { readOnlyDate,ReadOnlyValue } from './edit-impact'
import { TextField as SharedTextField } from '@/components/shared/text-field'
type RenderValueFieldsContext = {
  canWrite: boolean
  expiryBehavior: "stop" | "fallback"
  fallbackFieldError: string
  fallbackValue: string
  folderId: string
  folders: Folder[]
  foldersError: boolean
  item: CommonVarDetail | null
  loadFolders: (accountId: string) => Promise<void>
  memo: string
  name: string
  nameFieldError: string
  periodFieldError: string
  selectedAccountId: string | null
  setExpiryBehavior: Dispatch<SetStateAction<"stop" | "fallback">>
  setFallbackValue: Dispatch<SetStateAction<string>>
  setFolderId: Dispatch<SetStateAction<string>>
  setFolders: Dispatch<SetStateAction<Folder[]>>
  setMemo: Dispatch<SetStateAction<string>>
  setName: Dispatch<SetStateAction<string>>
  setNameFieldError: Dispatch<SetStateAction<string>>
  setPeriodFieldError: Dispatch<SetStateAction<string>>
  setSaved: Dispatch<SetStateAction<boolean>>
  setValidFrom: Dispatch<SetStateAction<string>>
  setValidUntil: Dispatch<SetStateAction<string>>
  validFrom: string
  validUntil: string
}

export function renderValueFields({ canWrite, expiryBehavior, fallbackFieldError, fallbackValue, folderId, folders, foldersError, item, loadFolders, memo, name, nameFieldError, periodFieldError, selectedAccountId, setExpiryBehavior, setFallbackValue, setFolderId, setFolders, setMemo, setName, setNameFieldError, setPeriodFieldError, setSaved, setValidFrom, setValidUntil, validFrom, validUntil }: RenderValueFieldsContext) {
  return (item ? (
    <div className={styles.sideGroup}>
      <section className={styles.sideCard} aria-labelledby="cv-edit-name-heading">
        <h2 id="cv-edit-name-heading" className={styles.sideTitle}>名前とフォルダ</h2>
        <div className={styles.sideFields}>
          <div className={styles.field}><Field label="名前" htmlFor="cv-name"><SaveErrorField names={["name","saved"]}><SharedTextField
              id="cv-name"
              type="text"
              maxLength={200}
              value={name}
              onChange={(e) => { setSaved(false); setName(e.target.value); setNameFieldError('') }}
              className={styles.fieldInput}
              readOnly={!canWrite}
              aria-invalid={nameFieldError ? true : undefined}
              aria-describedby={nameFieldError ? 'cv-name-error' : undefined}
            /></SaveErrorField>
{nameFieldError ? <p id="cv-name-error" className={styles.fieldError} role="alert">{nameFieldError}</p> : null}</Field></div>
          {canWrite ? (
            <SaveErrorField names={["folderId","saved","folder_id"]}><FolderSelect
              aria-label="フォルダ"
              label="フォルダ"
              id="cv-folder"
              // 右の列の幅いっぱい。固定 240 は列（約206）より広く、縮んで字が真ん中に寄っていた。
              size="full"
              value={folderId}
              onChange={(next) => { setSaved(false); setFolderId(next) }}
              // 絵は「フォルダ：お店の情報」を1つの文で見せる（閉じたボタンの頭は label）。
              folders={folders.map(folderById)}
              onCreate={canWrite && selectedAccountId
                ? folderCreator((name, color) => api.folders.create({ kind: 'common_var', name, color, accountId: selectedAccountId }), folderById, (created) => setFolders((current) => [...current, created]))
                : undefined}
            /></SaveErrorField>
          ) : (
            // 閲覧のみ：選ぶ部品は置かず、選んでいるフォルダを文字で見せる。
            <ReadOnlyValue
              id="cv-folder"
              label="フォルダ"
              value={`フォルダ：${foldersError ? '確認できません' : folderId ? (folders.find((folder) => folder.id === folderId)?.name ?? '確認できません') : '未分類'}`}
            />
          )}
          {foldersError ? (
            <div className={styles.inlineError} data-folders-state="error">
              <p className={styles.fieldHint}>フォルダの一覧を読み込めませんでした。いまの設定のまま保存できます。</p>
              <Button
                type="button"
                onClick={() => {
                  if (item && selectedAccountId) return loadFolders(selectedAccountId)
                }}
               busyLabel="処理中…">
                再読み込み
              </Button>
            </div>
          ) : null}
        </div>
      </section>

      <section className={`${styles.sideCard} ${styles.periodCard}`} aria-labelledby="cv-edit-period-heading">
        <h2 id="cv-edit-period-heading" className={styles.sideTitle}>使える期間</h2>
        <div className={styles.sideFields}>
          <div className={styles.field}><Field label="始まり" htmlFor="cv-valid-from">{canWrite
              ? <SaveErrorField names={["validFrom","saved","valid_from"]}><DateTimeField id="cv-valid-from" value={validFrom} placeholder="未設定" invalid={Boolean(periodFieldError)} onChange={(v) => { setSaved(false); setValidFrom(v); setPeriodFieldError('') }} /></SaveErrorField>
              : <ReadOnlyValue id="cv-valid-from" value={readOnlyDate(validFrom)} />}</Field></div>
          <div className={styles.field}><Field label="終わり" htmlFor="cv-valid-until">{canWrite
              ? <SaveErrorField names={["validUntil","saved","valid_until"]}><DateTimeField id="cv-valid-until" value={validUntil} placeholder="未設定" invalid={Boolean(periodFieldError)} onChange={(v) => { setSaved(false); setValidUntil(v); setPeriodFieldError('') }} /></SaveErrorField>
              : <ReadOnlyValue id="cv-valid-until" value={readOnlyDate(validUntil)} />}
{periodFieldError ? <p className={styles.fieldError} role="alert">{periodFieldError}</p> : null}</Field></div>
        </div>
        <div className={styles.sideFields}>
          {canWrite ? (
            <SaveErrorField names={["expiryBehavior","saved","expiry_behavior"]}><Select
              size="content"
              aria-label="期間外の動き"
              id="cv-expiry-behavior"
              value={expiryBehavior}
              onChange={(next) => { setSaved(false); setExpiryBehavior(next as 'stop' | 'fallback') }}
              options={[{ value: 'stop', label: '期間外の動き：配信を止める' }, { value: 'fallback', label: '期間外の動き：代わりの値を出す' }]}
            /></SaveErrorField>
          ) : (
            <ReadOnlyValue
              id="cv-expiry-behavior"
              label="期間外の動き"
              value={expiryBehavior === 'fallback'
                ? '期間外の動き：代わりの値を出す'
                : expiryBehavior === 'stop'
                  ? '期間外の動き：配信を止める'
                  : '期間外の動き：確認できません'}
            />
          )}
          {expiryBehavior === 'fallback' && (
            <div className={styles.field}><Field label="代わりの値" htmlFor="cv-fallback-value">{!canWrite && (item.type === 'boolean' || (item.type as string) === 'date' || (item.type as string) === 'datetime') ? (
                <ReadOnlyValue id="cv-fallback-value" label="代わりの値" value={(item.type as string) === 'boolean' ? (fallbackValue || '未選択') : readOnlyDate(fallbackValue)} />
              ) : item.type === 'boolean' ? (
                <SaveErrorField names={["fallbackValue","saved","fallback_value"]}><Select
                  aria-label="代わりの値"
                  id="cv-fallback-value"
                  value={fallbackValue}
                  onChange={(next) => { setSaved(false); setFallbackValue(next) }}
                  options={[{ value: '', label: '選んでください' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
                /></SaveErrorField>
              ) : (item.type as string) === 'date' ? (
                <SaveErrorField names={["fallbackValue","saved","fallback_value"]}><DateField id="cv-fallback-value" value={fallbackValue} onChange={(v) => { setSaved(false); setFallbackValue(v) }} /></SaveErrorField>
              ) : (item.type as string) === 'datetime' ? (
                <SaveErrorField names={["fallbackValue","saved","fallback_value"]}><DateTimeField id="cv-fallback-value" value={fallbackValue} onChange={(v) => { setSaved(false); setFallbackValue(v) }} /></SaveErrorField>
              ) : (
                <SaveErrorField names={["fallbackValue","saved","fallback_value"]}><SharedTextField
                  id="cv-fallback-value"
                  type={item.type === 'number' ? 'number' : 'text'}
                  value={fallbackValue}
                  onChange={(e) => { setSaved(false); setFallbackValue(e.target.value) }}
                  placeholder="お問い合わせください"
                  className={styles.fieldInput}
                  readOnly={!canWrite}
                  aria-invalid={fallbackFieldError ? true : undefined}
                  aria-describedby={fallbackFieldError ? 'cv-fallback-error' : undefined}
                /></SaveErrorField>
              )}
{fallbackFieldError ? <p id="cv-fallback-error" className={styles.fieldError} role="alert">{fallbackFieldError}</p> : null}</Field></div>
          )}
        </div>
      </section>

      <section className={styles.sideCard} aria-labelledby="cv-edit-memo-heading">
        <h2 id="cv-edit-memo-heading" className={styles.sideTitle}>社内メモ</h2>
        <div className={styles.field}><Field label="メモ（お客さまには出ません）" htmlFor="cv-memo"><SaveErrorField names={["memo","saved"]}><TextField
            id="cv-memo"
            value={memo}
            onChange={(e) => { setSaved(false); setMemo(e.target.value) }}
            maxLength={1000}
            placeholder="店舗ごとに違うときは店舗の共通情報へ"
            title="店舗ごとに違うときは店舗の共通情報へ"
            readOnly={!canWrite}
          /></SaveErrorField></Field></div>
      </section>
    </div>
  ) : null)
}
