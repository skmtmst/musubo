'use client'

import Card from '@/components/shared/card'
import FolderSelect,{ folderById,folderCreator } from '@/components/shared/folder-select'
import { Field,TextInput } from '@/components/shared/form-controls'
import LayoutPicker from '@/components/shared/layout-picker'
import RadioCard,{ RadioCardGroup } from '@/components/shared/radio-card'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import SectionHeader from '@/components/shared/section-header'
import SegmentedControl from '@/components/shared/segmented'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import {
api
} from '@/lib/api'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { type RichMenuTemplate } from '@/lib/rich-menu-templates'
import { useFormErrors } from '@/lib/use-form-errors'
import {
RICH_MENU_DIMENSIONS,
type Folder
} from '@line-crm/shared'
import type { Dispatch,JSX,SetStateAction } from 'react'
import { MAX_TAB_PAGES } from './create-model'
import { SIZE_OPTIONS,TAB_COUNT_OPTIONS,V8_LAYOUT_KEYS,V8_LAYOUT_LABEL } from './create-options'
import { type Group,type Page } from './create-types'
import styles from '../../../app/rich-menus/new/create-v8.module.css'

type RenderShapeStepContext = {
  accountId: string | null
  busy: boolean
  canOperate: boolean
  chatBarText: string
  defaultTabName: (index: number, count: number) => string
  fields: ReturnType<typeof useFormErrors>
  folderId: string
  folders: Folder[]
  group: Group | null
  host: RichMenuCreateHost | undefined
  locked: boolean
  name: string
  pages: Page[]
  renderSingleImage: () => JSX.Element
  renderTabImageSlot: (index: number) => JSX.Element
  requestTabCount: (next: number) => void
  setChatBarText: Dispatch<SetStateAction<string>>
  setFolderId: Dispatch<SetStateAction<string>>
  setFolders: Dispatch<SetStateAction<Folder[]>>
  setName: Dispatch<SetStateAction<string>>
  setSize: Dispatch<SetStateAction<"large" | "compact">>
  setTabNames: Dispatch<SetStateAction<string[]>>
  setTemplateKey: Dispatch<SetStateAction<string>>
  shownLayouts: RichMenuTemplate[]
  size: "large" | "compact"
  tabCount: number
  tabNames: string[]
  templateKey: string
  updatePage: (pageId: string, patch: Partial<Page>) => void
}

export function renderShapeStep({ accountId, busy, canOperate, chatBarText, defaultTabName, fields, folderId, folders, group, host, locked, name, pages, renderSingleImage, renderTabImageSlot, requestTabCount, setChatBarText, setFolderId, setFolders, setName, setSize, setTabNames, setTemplateKey, shownLayouts, size, tabCount, tabNames, templateKey, updatePage }: RenderShapeStepContext) {
    const dims = RICH_MENU_DIMENSIONS[size]
    /* タブの数（ページの数）。作った後はページの数、作る前は①で選んだ数。 */
    const slotCount = group ? pages.length : tabCount + 1
    const hasTabs = slotCount > 1
    const tabValue = String(Math.max(0, Math.min(group ? pages.length - 1 : tabCount, MAX_TAB_PAGES - 1)))
    const shapeLocked = locked || busy

    return (
      <>
        <Card variant="form" gap="normal">
          <SectionHeader title="名前とフォルダ" />
          <SettingsFormRow layout="name-folder">
            <Field requirement={fields.requirement('name')} label="メニュー名（友だちには見えません）" htmlFor="rm-name" error={fields.error('name')}>
              <SaveErrorField names={["name"]}><TextInput {...fields.bind('name')} id="rm-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：通常メニュー（会員向け）" invalid={fields.invalid('name')} /></SaveErrorField>
            </Field>
            <Field label="フォルダ">
              <SaveErrorField names={["folderId","folder_id"]}><FolderSelect aria-label="フォルダ" value={folderId} onChange={setFolderId}
                folders={folders.map(folderById)} size="full"
                colors
                onCreate={!canOperate
                  ? undefined
                  : host
                    ? (host.createFolder
                      ? folderCreator(async (name, color) => ({ success: true as const, data: await host.createFolder!(name, color) }), folderById, (created) => setFolders((current) => [...current, created as Folder]))
                      : undefined)
                    // 一覧の左の列の「フォルダを追加」と同じ口（リッチメニューのフォルダは共有）。
                    : folderCreator((name, color) => api.folders.create({ kind: 'rich_menu', name, color, accountId }), folderById, (created) => setFolders((current) => [...current, created]))} /></SaveErrorField>
            </Field>
          </SettingsFormRow>
          <Field label="トーク画面の下の文言（14文字まで）" htmlFor="rm-chatbar" requirement={fields.requirement('chatbar')} error={fields.error('chatbar')}>
            <SaveErrorField names={["chatBarText","chat_bar_text"]}><TextInput {...fields.bind('chatbar')} id="rm-chatbar" value={chatBarText} maxLength={14} onChange={(e) => setChatBarText(e.target.value)} placeholder="メニュー" invalid={fields.invalid('chatbar')} /></SaveErrorField>
          </Field>
        </Card>

        <Card variant="form" gap="normal">
          <SectionHeader title="大きさと切替タブ" />
          <SaveErrorField names={["rich-menu-size","value","opt.value","size"]}><RadioCardGroup legend="大きさ" className="grid grid-cols-2 gap-3">
            {SIZE_OPTIONS.map((opt) => <RadioCard key={opt.value} name="rich-menu-size" value={opt.value}
              title={`${opt.label} ${opt.dims}`} note={opt.hint} icon={<opt.icon size={16} aria-hidden="true" />} checked={size === opt.value}
              disabled={shapeLocked}
              onChange={() => {
                if (shapeLocked) return
                setSize(opt.value)
                const first = V8_LAYOUT_KEYS[opt.value][0]
                if (first) setTemplateKey(first)
              }} />)}
          </RadioCardGroup></SaveErrorField>
          {locked ? (
            <p className={styles.fieldHint}>形は下書きを作ったあとは変えられません。別の形で作るときは、新しく作り直してください。</p>
          ) : null}
          <div className={styles.segRow}>
            <span className={styles.segLabel}>切替タブの数</span>
            <SaveErrorField names={["length","pages.length","tabCount","MAX_TAB_PAGES"]}><SegmentedControl
              aria-label="切替タブの数"
              options={TAB_COUNT_OPTIONS}
              value={tabValue}
              onChange={(v) => {
                if (busy) return
                const next = Number(v)
                if (!Number.isInteger(next) || next < 0) return
                requestTabCount(next)
              }}
              disabled={busy}
            /></SaveErrorField>
            <span className={styles.segHint}>タブで別のメニューへ移れます</span>
          </div>
          {/* 採用案 K6Ot7O：タブの数だけ名前の欄（トーク画面のタブに出る名前）。 */}
          {hasTabs ? (
            <div className={styles.tabNameGrid}>
              {Array.from({ length: slotCount }, (_, i) => (
                <Field key={i} label={`タブ${i + 1}の名前（トーク画面のタブに出ます）`} htmlFor={`rm-tab-name-${i}`}>
                  <SaveErrorField names={[`pages.${i}.name`, `tabNames.${i}`]}><TextInput
                    id={`rm-tab-name-${i}`}
                    maxLength={14}
                    value={group ? pages[i]?.name ?? '' : tabNames[i] ?? defaultTabName(i, tabCount)}
                    onChange={(e) => {
                      const value = e.target.value
                      if (group) {
                        const page = pages[i]
                        if (page) updatePage(page.id, { name: value })
                        return
                      }
                      setTabNames((prev) => {
                        const next = Array.from({ length: tabCount + 1 }, (_, k) => prev[k] ?? defaultTabName(k, tabCount))
                        next[i] = value
                        return next
                      })
                    }}
                  /></SaveErrorField>
                </Field>
              ))}
            </div>
          ) : null}
        </Card>

        {/* 面の分け方 */}
        <Card variant="form" gap="normal">
          <div className={`flex flex-col ${styles.stackCompact}`}>
            <SectionHeader title="面の分け方" />
            <p className={styles.cardNote}>押せるところをいくつに分けるか。あとで区切り直せます</p>
          </div>
          <LayoutPicker
            value={templateKey} onChange={(next) => { if (!shapeLocked) setTemplateKey(next) }} disabled={shapeLocked}
            preview={size === 'compact' ? 'compact-menu' : 'menu'}
            options={shownLayouts.map((item) => ({
              value: item.key, label: V8_LAYOUT_LABEL[item.key] ?? item.label,
              areas: item.areas.map((area, index) => ({
                label: index < 26 ? String.fromCharCode(65 + index) : String(index + 1),
                x: area.x / RICH_MENU_DIMENSIONS[size].width * 100,
                y: area.y / RICH_MENU_DIMENSIONS[size].height * 100,
                width: area.w / RICH_MENU_DIMENSIONS[size].width * 100,
                height: area.h / RICH_MENU_DIMENSIONS[size].height * 100,
              })),
            }))}
          />
        </Card>

        {/* 画像（採用案 K6Ot7O：タブがあるときはタブごとに1枚、枠を横に並べる）。 */}
        <Card variant="form" gap="normal">
          <div className={`flex flex-col ${styles.stackCompact}`}>
            <SectionHeader title={hasTabs ? '画像（タブごとに1枚）' : '画像'} />
            <p className={styles.cardNote}>
              {dims.width}×{dims.height}px・PNG か JPEG・1MB まで{hasTabs ? '。タブの数だけ入れます' : ''}
            </p>
          </div>
          {hasTabs ? (
            <div className={styles.tabImageGrid}>
              {Array.from({ length: slotCount }, (_, i) => renderTabImageSlot(i))}
            </div>
          ) : (
            renderSingleImage()
          )}
        </Card>
      </>
    )
  }
