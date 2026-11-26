'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Card from '@/components/shared/card'
import SectionHeader from '@/components/shared/section-header'
import Button from '@/components/shared/button'
import Chip from '@/components/shared/chip'
import LinePreview from '@/components/shared/line-preview'
import { Field, TextInput } from '@/components/shared/form-controls'
import NumberInput from '@/components/shared/number-field'
import SegmentedControl from '@/components/shared/segmented'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'
import FolderSelect from '@/components/shared/folder-select'
import { MediaLimitNote } from '@/components/shared/media-slot'
import Notice from '@/components/shared/notice'
import ConditionBuilder from '@/components/shared/condition-builder'
import { AreaProperties } from '@/components/rich-menus/area-properties'
import type { Area } from '../../components/rich-menus/area-types'
import { createAreaDrafts, isAreaActionConfigured, saveAreaDraft, unsetAreaLabels } from '@/components/rich-menus/action-drafts'
import { SIZE_DIMENSIONS, TEMPLATES, type RichMenuTemplate } from '@/lib/rich-menu-templates'
import type { RichMenuAreaIntent } from '@line-crm/shared'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { STORE_NEW_MENU_INTENTS, RichMenuTemplatePreview, type RichMenuOption, type RichMenuFolderOption, type RichMenuCreateValue } from '../../components/rich-menus/rich-menu-create-model'
import { ToggleField } from '@/components/shared/toggle'

const SIZE_TABS: { value: 'large' | 'compact'; label: string; dims: string; hint: string }[] = [
  { value: 'large', label: '大きい', dims: `${SIZE_DIMENSIONS.large.width} × ${SIZE_DIMENSIONS.large.height}px`, hint: '画面をしっかり使う。ボタンを6つまで置ける' },
  { value: 'compact', label: '小さい', dims: `${SIZE_DIMENSIONS.compact.width} × ${SIZE_DIMENSIONS.compact.height}px`, hint: 'トークが隠れにくい。横に並べる形' },
]

const LARGE_TEMPLATE_ORDER = [
  'large-full', 'large-1x2-v', 'large-1x2-h', 'large-1plus2',
  'large-2x2', 'large-2plus1', 'large-2x3',
] as const

const TEMPLATE_LABELS: Record<string, string> = {
  'large-full': '1面',
  'large-1x2-v': '上下2面',
  'large-1x2-h': '左右2面',
  'large-1plus2': '上1・下2',
  'large-2x2': '4面',
  'large-2plus1': '上2・下1',
  'large-2x3': '6面',
}

type Props = {
  value: RichMenuCreateValue
  onChange: (next: RichMenuCreateValue) => void
  folders?: RichMenuFolderOption[]
  tags?: RichMenuOption[]
  templates?: RichMenuOption[]
  forms?: RichMenuOption[]
  trackedLinks?: RichMenuOption[]
  allowedIntents?: RichMenuAreaIntent[]
  disabled?: boolean
  compatibilityError?: string | null
  validationError?: string | null
  /**
   * その場の入力欄エラー（作成画面の保存前検証用）。
   * 渡すと該当の入力欄の下にその場で出し、欄へフォーカスできるよう
   * 欄に id を付ける。ページ最下部の帯には出さない。
   */
  nameError?: string | null
  chatBarTextError?: string | null
  /**
   * N-161: 「最初に見せるページ・出す相手・全員既定」の入力を出すか。
   * 統括ひな形（HQ）はこの3つを保存できないため、そこでは付けない。
   * 出したまま保存先に無いと、入力が黙って捨てられる。
   */
  audienceSetup?: boolean
  imageAction?: ReactNode
  footer?: ReactNode
}

export default function RichMenuCreateForm({
  value,
  onChange,
  folders = [],
  tags = [],
  templates = [],
  forms = [],
  trackedLinks = [],
  allowedIntents = STORE_NEW_MENU_INTENTS,
  disabled = false,
  compatibilityError,
  validationError,
  nameError,
  chatBarTextError,
  audienceSetup = false,
  imageAction,
  footer,
}: Props) {
  const [editingAreaIndex, setEditingAreaIndex] = useState<number | null>(null)
  const [editingArea, setEditingArea] = useState<Area | null>(null)
  const shownTemplates = useMemo(() => {
    const bySize = TEMPLATES.filter((template) => template.size === value.size)
    if (value.size === 'compact') return bySize
    return LARGE_TEMPLATE_ORDER
      .map((key) => bySize.find((template) => template.key === key))
      .filter((template): template is RichMenuTemplate => Boolean(template))
  }, [value.size])
  const template = shownTemplates.find((item) => item.key === value.templateKey) ?? shownTemplates[0]
  const initialAreas = useMemo(() => createAreaDrafts(template), [template])
  const currentAreas = value.areaDraftsByTemplate[template.key] ?? initialAreas
  const unsetLabels = unsetAreaLabels(currentAreas)
  const locked = disabled || Boolean(compatibilityError)
  const patch = (next: Partial<RichMenuCreateValue>) => onChange({ ...value, ...next })

  /*
   * N-161: 作成前はページに実IDがない。切替ボタンの行き先と既定ページは
   * orderIndex（= ここでは文字列化した番号）で持ち、送信時に
   * actionData.targetPageIndex / defaultPageIndex へ写す。
   */
  const createPages = useMemo(
    () => Array.from({ length: value.tabCount + 1 }, (_, index) => ({
      id: String(index),
      name: index === 0 ? 'トップ' : `タブ ${String.fromCharCode(65 + index - 1)}`,
    })),
    [value.tabCount],
  )

  function changeSize(size: 'large' | 'compact') {
    const first = TEMPLATES.find((item) => item.size === size)
    patch({ size, ...(first ? { templateKey: first.key } : {}) })
    setEditingAreaIndex(null)
    setEditingArea(null)
  }

  function selectTemplate(templateKey: string) {
    patch({ templateKey })
    setEditingAreaIndex(null)
    setEditingArea(null)
  }

  function openAreaEditor(index: number) {
    const area = currentAreas[index]
    if (!area || locked) return
    setEditingAreaIndex(index)
    setEditingArea({ ...area, actionData: { ...area.actionData }, tagIds: [...(area.tagIds ?? [])] })
  }

  function saveEditingArea() {
    if (editingAreaIndex === null || !editingArea) return
    onChange({
      ...value,
      areaDraftsByTemplate: {
        ...value.areaDraftsByTemplate,
        [template.key]: saveAreaDraft(currentAreas, editingAreaIndex, editingArea),
      },
    })
    setEditingAreaIndex(null)
    setEditingArea(null)
  }


  return <Card padding="roomy" layout="vertical" gap="normal">
    {compatibilityError || validationError ? <Notice tone="danger" message={compatibilityError ?? validationError ?? ''} /> : null}
    <SectionHeader title="形と画像" />
    <Field label="メニュー名" htmlFor="rich-menu-name" required error={nameError ?? undefined} note="管理画面での識別用です。友だちには表示されません。">
      <SaveErrorField names={["name","value.name"]}><TextInput id="rich-menu-name" value={value.name} onChange={event => patch({ name: event.target.value })} disabled={locked} placeholder="例：メインメニュー" /></SaveErrorField>
    </Field>
    <Field label="フォルダ" htmlFor="rich-menu-folder">
      <SaveErrorField names={["folderId","value.folderId","folder_id","value.folder_id"]}><FolderSelect id="rich-menu-folder" aria-label="フォルダ" value={value.folderId} disabled={locked || folders.length === 0} onChange={next => patch({ folderId: next })} folders={folders.map(folder => ({ value: folder.id, label: folder.name }))} size="full" /></SaveErrorField>
    </Field>
    <Field label="トーク画面の下の文言" htmlFor="rich-menu-chat-bar-text" required error={chatBarTextError ?? undefined} note="14文字以内。メニューを開く前にトーク画面下に表示されます。">
      <SaveErrorField names={["chatBarText","value.chatBarText","chat_bar_text","value.chat_bar_text"]}><TextInput id="rich-menu-chat-bar-text" value={value.chatBarText} onChange={event => patch({ chatBarText: event.target.value })} disabled={locked} maxLength={14} /></SaveErrorField>
    </Field>
    <RadioCardGroup legend="画像の大きさ" legendVisible>
      {SIZE_TABS.map(item => <RadioCard key={item.value} name="compat-size" value={item.value} checked={value.size === item.value} disabled={locked} onChange={() => changeSize(item.value)} title={item.label} note={`${item.dims}・${item.hint}`} />)}
    </RadioCardGroup>
    <Field label="切替タブの数" note="タブでほかのメニューへ移れます。切り替えが要らないときは「なし」。">
      <SegmentedControl aria-label="切替タブの数" value={String(value.tabCount)} disabled={locked}
        options={[0, 1, 2, 3].map(count => ({ value: String(count), label: count === 0 ? 'なし' : `${count}つ` }))}
        onChange={next => { const count = Number(next); patch({ tabCount: count, defaultPageIndex: Math.min(value.defaultPageIndex, count) }) }} />
    </Field>
    <SaveErrorField names={["template","key","item.key","templateKey","value.templateKey"]}><RadioCardGroup legend="面の分けかた" legendVisible>
      {shownTemplates.map(item => <RadioCard key={item.key} name="template" value={item.key} checked={value.templateKey === item.key} disabled={locked} onChange={selectTemplate} title={TEMPLATE_LABELS[item.key] ?? item.label} note={<RichMenuTemplatePreview template={item} />} />)}
    </RadioCardGroup></SaveErrorField>

    {audienceSetup ? <Card variant="form" padding="roomy" layout="vertical" gap="normal">
      <SectionHeader title="最初に見せるページと、出す相手" />
      {value.tabCount > 0 ? <Field label="最初に見せるページ" htmlFor="rich-menu-default-page" note="タブを切り替えていない人が最初に見るページです。">
        <SaveErrorField names={["defaultPageIndex","value.defaultPageIndex","default_page_index","value.default_page_index"]}><EntitySelect id="rich-menu-default-page" aria-label="最初に見せるページ" value={String(value.defaultPageIndex)} disabled={locked} onChange={next => patch({ defaultPageIndex: Number(next) })} options={createPages.map(page => ({ ...entityOptionMetadata(page), value: page.id, label: page.name }))} /></SaveErrorField>
      </Field> : null}
      <SaveErrorField names={["create-audience","targetingEnabled","value.targetingEnabled"]}><RadioCardGroup legend="出す相手" legendVisible>
        <RadioCard name="create-audience" value="all" checked={!value.targetingEnabled} disabled={locked} onChange={() => patch({ targetingEnabled: false })} title="すべての友だち" note="ほかの出し分けに当てはまらなかった人へ出ます" />
        <RadioCard name="create-audience" value="targeted" checked={value.targetingEnabled} disabled={locked} onChange={() => patch({ targetingEnabled: true, isDefaultForAll: false })} title="条件に当てはまる友だちだけ" note="当てはまらない人には、これより下のメニューが出ます" />
      </RadioCardGroup></SaveErrorField>
      {value.targetingEnabled ? <>
        <fieldset disabled={locked} className="contents"><ConditionBuilder value={value.targetingCondition} onChange={condition => patch({ targetingCondition: condition })} label="条件" /></fieldset>
        <Field label="出す順番" htmlFor="create-targeting-priority" note="ほかの出し分けにも当てはまる人には、順番が早いメニューが出ます。">
          <SaveErrorField names={["targetingPriority","value.targetingPriority","targeting_priority","value.targeting_priority"]}><NumberInput id="create-targeting-priority" min={1} unit="番目" disabled={locked} value={value.targetingPriority + 1} onChange={event => patch({ targetingPriority: Math.max(0, Number(event.target.value) - 1) })} /></SaveErrorField>
        </Field>
      </> : null}
      <SaveErrorField names={["isDefaultForAll","value.isDefaultForAll","is_default_for_all","value.is_default_for_all"]}><ToggleField checked={value.isDefaultForAll} disabled={locked || value.targetingEnabled} onChange={checked => patch({ isDefaultForAll: checked })} description={value.targetingEnabled ? '出し分けを選んだメニューは全員の既定にはできません。' : '公開のときにLINEの既定へ設定します。ほかに既定のメニューがある場合は入れ替わります。'}>公開したら「すべての友だち」の既定メニューにする</ToggleField></SaveErrorField>
    </Card> : null}

    <Card variant="form" padding="roomy" layout="vertical" gap="normal">
      <SectionHeader title="トークを開いたとき" />
      <p>メニューを開いた状態・閉じた状態の指定は、下書き保存後の編集画面で設定します。</p>
      <SectionHeader title="画像" />
      {imageAction ?? <Button href="/contents">登録メディアから選択する</Button>}
      <p>{SIZE_DIMENSIONS.large.width} × {SIZE_DIMENSIONS.large.height}px ／ 1MBまで・JPG・PNG</p>
      <p>選んだ画像は下書きの最初に見せるページへ登録します。</p>
    </Card>

    <Card variant="form" padding="roomy" layout="vertical" gap="normal" aria-label="押した面ごとの動き">
      <SectionHeader title="押した面ごとの動き" />
      {currentAreas.map((area, index) => <Card key={area.id} variant="panel" padding="compact" layout="vertical" gap="tight">
        <SectionHeader title={`面 ${String.fromCharCode(65 + index)}「${isAreaActionConfigured(area) ? area.label || 'アクション設定済み' : 'アクションを実行'}」`}
          note={isAreaActionConfigured(area) ? undefined : <Chip tone="neutral">未設定</Chip>}
          actions={<Button type="button" variant="text" size="inline" disabled={locked} onClick={() => openAreaEditor(index)}>{isAreaActionConfigured(area) ? '設定を変更する' : '設定する'}</Button>} />
        {editingAreaIndex === index && editingArea ? <>
          <AreaProperties area={editingArea} pages={createPages} tags={tags} templates={templates} forms={forms} trackedLinks={trackedLinks} taps={null} showManagementDetails={false} allowedIntents={allowedIntents} onUpdate={areaPatch => setEditingArea(current => current ? { ...current, ...areaPatch } : current)} />
          <Card layout="horizontal" gap="tight">
            <Button type="button" onClick={() => { setEditingAreaIndex(null); setEditingArea(null) }}>キャンセル</Button>
            <Button type="button" variant="primary" disabled={locked} onClick={saveEditingArea}>この面の設定を保存する</Button>
          </Card>
        </> : null}
      </Card>)}
      <Notice tone={unsetLabels.length > 0 ? 'warn' : 'success'} message={currentAreas.length === 0 ? '面を追加し、公開前にそれぞれのアクションを設定してください。' : unsetLabels.length > 0 ? `面 ${unsetLabels.join('、')} のアクションが未設定です。公開すると、その場所を押しても何も起きません。` : 'すべての面にアクションが設定されています。'} />
    </Card>
    <LinePreview note="メニューを開くボタンの文字と面の分け方を確認できます"><p>{value.chatBarText || 'メニュー'}</p><RichMenuTemplatePreview template={template} /></LinePreview>
    <Notice tone="warn" heading="公開前に見ておくところ"><p>アクションが未設定の面が {unsetLabels.length}つあります</p><MediaLimitNote maxMb={1} /><p>切替メニューの移動先は、公開してからでないと動きません</p></Notice>
    {footer}
  </Card>
}
