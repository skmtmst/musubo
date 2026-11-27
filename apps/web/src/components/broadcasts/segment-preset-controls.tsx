'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SavedSegmentPreset } from '@line-crm/shared'
import { api } from '@/lib/api'
import {
  pruneCondition,
  type SegmentCondition,
} from '@/lib/segment-condition'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import { notifyToast } from '@/components/shared/toast'
import { NOT_AVAILABLE, NotConnected } from '@/components/shared/not-connected'
import { conditionFromSegmentPreset } from './segment-preset'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/**
 * 保存した対象条件の数（設計 `sqFXf` のKPI3枚）。
 *
 * まだ繋がっていないので、数の代わりに理由を出す。文言は画面共通の
 * 「未接続」の書き方にそろえる。
 */
const PRESET_KPIS = [
  {
    label: 'いま当てはまる人数',
    source: '保存した条件ごとに人数を数える口',
  },
  {
    label: 'この条件を使っている配信',
    source: '条件の使い先を返す口',
  },
  {
    label: '最後に使った日',
    source: '条件を使った記録',
  },
] as const

type SegmentPresetControlsProps = {
  accountId: string | null
  value: SegmentCondition | null
  onApply: (condition: SegmentCondition) => void
}

export default function SegmentPresetControls({
  accountId,
  value,
  onApply,
}: SegmentPresetControlsProps) {
  const saveErrors = useSaveFormErrors()

  const [chooserOpen, setChooserOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [presets, setPresets] = useState<SavedSegmentPreset[]>([])
  const [presetsAccountId, setPresetsAccountId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [name, setName] = useState('')
  const [isShared, setIsShared] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const currentAccountIdRef = useRef(accountId)
  const loadGenerationRef = useRef(0)
  const saveGenerationRef = useRef(0)
  currentAccountIdRef.current = accountId

  const usableCondition = pruneCondition(value)
  const accountMissing = !accountId

  useEffect(() => {
    // 切替前の一覧・確認窓・完了表示を、新しいアカウントへ持ち越さない。
    loadGenerationRef.current += 1
    saveGenerationRef.current += 1
    setChooserOpen(false)
    setSaveOpen(false)
    setPresets([])
    setPresetsAccountId(null)
    setLoading(false)
    setLoadError('')
    setSaving(false)
    setSaveError('')
  }, [accountId])

  const loadPresets = useCallback(async () => {
    if (!accountId) {
      setLoadError('先にLINEアカウントを選んでください。')
      setPresets([])
      return
    }
    const requestAccountId = accountId
    const generation = ++loadGenerationRef.current
    setLoading(true)
    setLoadError('')
    try {
      const result = await api.segmentPresets.list(requestAccountId)
      if (currentAccountIdRef.current !== requestAccountId || loadGenerationRef.current !== generation) return
      if (result.success) {
        setPresets(result.data)
        setPresetsAccountId(requestAccountId)
      } else {
        setPresets([])
        setPresetsAccountId(null)
        setLoadError('保存した条件を表示できませんでした。時間をおいて、もう一度お試しください。')
      }
    } catch (saveFailure) {
      if (currentAccountIdRef.current !== requestAccountId || loadGenerationRef.current !== generation) return
      const fieldFailure = saveErrors.capture(saveFailure)
      setPresets([])
      setPresetsAccountId(null)
      { if (!fieldFailure) setLoadError('保存した条件を表示できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      if (currentAccountIdRef.current === requestAccountId && loadGenerationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [accountId, saveErrors])

  const openChooser = () => {
    setChooserOpen(true)
    void loadPresets()
  }

  const openSave = () => {
    setName('')
    setIsShared(true)
    setSaveError('')
    setSaveOpen(true)
  }

  const savePreset = async () => {
    const nextName = name.trim()
    const nextCondition = pruneCondition(value)
    if (!accountId) {
      setSaveError('先にLINEアカウントを選んでください。')
      return
    }
    if (!nextCondition) {
      setSaveError('保存する条件を1つ以上入力してください。')
      return
    }
    if (!nextName) {
      setSaveError('条件の名前を入力してください。')
      return
    }
    const requestAccountId = accountId
    const generation = ++saveGenerationRef.current
    setSaving(true)
    setSaveError('')
    try {
      const result = await api.segmentPresets.create({
        name: nextName,
        accountId: requestAccountId,
        condition: nextCondition,
        isShared,
      })
      if (currentAccountIdRef.current !== requestAccountId || saveGenerationRef.current !== generation) return
      if (!result.success) {
        setSaveError('条件を保存できませんでした。入力内容を確認して、もう一度お試しください。')
        return
      }
      setPresets((items) => [result.data, ...items.filter((item) => item.id !== result.data.id)])
      setSaveOpen(false)
      notifyToast(`「${result.data.name}」として保存しました。`)
    } catch (saveFailure) {
      if (currentAccountIdRef.current !== requestAccountId || saveGenerationRef.current !== generation) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure) setSaveError('条件を保存できませんでした。入力内容を確認して、もう一度お試しください。') }
    } finally {
      if (currentAccountIdRef.current === requestAccountId && saveGenerationRef.current === generation) {
        setSaving(false)
      }
    }
  }

  const applyPreset = (preset: SavedSegmentPreset) => {
    if (!accountId || presetsAccountId !== accountId || preset.lineAccountId !== accountId) {
      setPresets([])
      setPresetsAccountId(null)
      setLoadError('アカウントが切り替わりました。保存した条件を読み直してください。')
      return
    }
    onApply(conditionFromSegmentPreset(preset))
    setChooserOpen(false)
    notifyToast(`「${preset.name}」の条件を読み込みました。`)
  }

  return (
    <SaveErrorScope errors={saveErrors}><>
      <div className="flex flex-wrap items-center gap-2" data-design-node="cPk8A">
        <Button
          type="button"
          variant="secondary"
          onClick={openSave}
          disabled={accountMissing || !usableCondition}
          title={accountMissing
            ? '先にLINEアカウントを選んでください'
            : !usableCondition
              ? '詳細条件を1つ以上入力してください'
              : undefined}
          className="min-h-0 px-3 py-1 text-xs"
        >
          この条件を保存する
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={openChooser}
          disabled={accountMissing}
          title={accountMissing ? '先にLINEアカウントを選んでください' : undefined}
          className="min-h-0 px-3 py-1 text-xs"
        >
          保存した条件から選択する
        </Button>
      </div>

      {/* 押せない理由は吹き出しに隠さない。触らないと分からない形にすると、
          「壊れている」と読まれる。 */}
      {accountMissing || !usableCondition ? (
        <p className="text-ink-faint mt-2 text-xs leading-relaxed">
          {accountMissing
            ? '先にLINEアカウントを選ぶと、この条件を保存できます。'
            : '詳細条件を1つ以上入力すると、この条件を保存できます。'}
        </p>
      ) : null}

      <Dialog
        open={saveOpen}
        title="この対象条件を保存"
        description="次の一斉配信でも同じ条件を呼び出せます。"
        confirmLabel="保存する"
        busy={saving}
        error={saveError || undefined}
        onCancel={() => { if (!saving) setSaveOpen(false) }}
        onConfirm={() => void savePreset()}
      >
        <div className="space-y-4" data-design-node="sqFXf">
          <label className="block">
            <span className="text-ink block text-sm font-bold">条件の名前</span>
            <SaveErrorField names={["name"]}><SharedTextField
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="例：この30日で反応した友だち"
              className="border-hairline rounded-control mt-2 w-full border bg-canvas px-3 py-2 text-sm text-ink"
              autoFocus
            /></SaveErrorField>
          </label>
          <SaveErrorField names={["isShared","is_shared"]}><Checkbox
            checked={isShared}
            onCheckedChange={setIsShared}
            description="外すと、自分だけが呼び出せます。"
          >同じLINEアカウントを扱う運用者と共有する</Checkbox></SaveErrorField>
        </div>
      </Dialog>

      <Dialog
        open={chooserOpen}
        title="保存した対象条件から選ぶ"
        description="選ぶと、この画面の詳細条件へ読み込みます。"
        onCancel={() => setChooserOpen(false)}
      >
        <div className="space-y-3" data-design-node="sqFXf">
          {/*
            設計はここに数を3つ出している（当てはまる人数・使われている配信・
            最後に使った日）。どれも保存した条件の側では持っていない。
            `api.segmentPresets.list` が返すのは名前・共有範囲・並び順だけで、
            人数を数える口も、使った記録も無い。

            **0や見た目だけの数を置かない。**「—」と、なぜ出ないかを書く。
            口が付いたら数へ差し替える（引き継ぎは `docs/design-qa/`）。
          */}
          <dl className="border-hairline rounded-control grid grid-cols-1 gap-px overflow-hidden border bg-hairline sm:grid-cols-3">
            {PRESET_KPIS.map((kpi) => (
              <div key={kpi.label} className="bg-canvas p-3">
                <dt className="text-ink-faint text-xs">{kpi.label}</dt>
                <dd className="text-ink-faint mt-1 text-lg font-bold tabular-nums">{NOT_AVAILABLE}</dd>
                <dd className="mt-0.5"><NotConnected source={kpi.source} /></dd>
              </div>
            ))}
          </dl>
          {loading ? <ListState kind="loading" /> : null}
          {!loading && loadError ? (
            <ListState
              kind="error"
              title="保存した条件を表示できませんでした"
              description="通信状態を確認して、もう一度お試しください。"
              onRetry={() => void loadPresets()}
            />
          ) : null}
          {!loading && !loadError && presets.length === 0 ? (
            <ListState
              kind="empty"
              title="保存した条件はまだありません"
              description="詳細条件を入力し、「この条件を保存」から作成できます。"
            />
          ) : null}
          {!loading && !loadError && presets.length > 0 ? (
            <ul className="divide-y divide-hairline rounded-card border border-hairline bg-canvas">
              {presets.map((preset) => (
                <li key={preset.id} className="flex items-center justify-between gap-4 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-ink" title={preset.name}>{preset.name}</p>
                    <p className="mt-1 text-xs text-ink-faint">{preset.isShared ? '運用者と共有' : '自分だけ'}</p>
                  </div>
                  <Button type="button" variant="secondary" onClick={() => applyPreset(preset)}>この条件を使う</Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Dialog>
    </></SaveErrorScope>
  )
}
