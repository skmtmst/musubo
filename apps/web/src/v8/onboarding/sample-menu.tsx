'use client'

import type { CSSProperties } from 'react'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import MusuboMark from '@/components/shared/musubo-mark'
import { INITIAL_MENUS, initialMenuImageDataUri, type AccountStyle } from '@line-crm/shared'
import { SetupIcon } from './icons'
import { sampleMenuFor } from './model'
import styles from './sample-menu.module.css'
import type { StarterButton } from './use-starter-menu'

/*
 * 見本のリッチメニュー（★V8 修正案 wI4ZX・RZW83 の「入る見本」・cAaGY の「お客さまの見え方」）。
 * 2 列 × 2 段のボタン。保存済みの画像・座標があるときは、その内容を表示する。
 */

export function SampleMenuTiles({ style, buttons, selected, warned = [], onSelect, size = 'panel', label, imageUrl: rawImageUrl, imageHeight: rawImageHeight=1686 }: {
  imageUrl?:string|null
  imageHeight?:number
  style: AccountStyle
  buttons?: StarterButton[]
  /** 選んでいるボタン（お客さまの見え方で、押したときを出しているボタン）。 */
  selected?: number | null
  /** 中身が未設定の機能（feature）。押せる見本で、選んだ形の枠を出す。 */
  warned?: string[]
  onSelect?: (index: number) => void
  size?: 'panel' | 'preview' | 'phone'
  label?: string
}) {
  const menu = sampleMenuFor(style)
  const tiles:Array<StarterButton & {icon:string}> = buttons ? buttons.map(button => ({ ...button, icon: menu.tiles.find(tile => tile.feature === button.feature)?.icon ?? 'file' })) : menu.tiles
  const imageUrl = typeof rawImageUrl === 'string' && rawImageUrl.trim() ? rawImageUrl.trim() : null
  const imageHeight = Number.isFinite(rawImageHeight) && rawImageHeight > 0 ? rawImageHeight : 1686
  const initial=rawImageUrl!==null&&tiles.length===4&&tiles.every((tile,index)=>tile.label===INITIAL_MENUS[style].buttons[index]!.label)
  const tone = { '--sample-bg': menu.tone.bg, '--sample-ink': menu.tone.ink } as CSSProperties
  return (
    <div className={styles.grid} data-size={size} style={{...tone,...(imageUrl||initial?{backgroundImage:`url(${JSON.stringify(imageUrl??initialMenuImageDataUri(style))})`,aspectRatio:`2500 / ${imageHeight}`}:{})}} data-initial={initial||undefined} data-image={imageUrl?true:undefined} role={onSelect ? 'group' : undefined} aria-label={label ?? '見本のリッチメニュー'}>
      {tiles.map((tile, index) => {
        const body = <><SetupIcon name={tile.icon} className={styles.icon} /><span className={styles.label}>{tile.label}</span></>
        const tileKey = `${tile.feature}-${index}`
        return onSelect ? (
          <button key={tileKey} type="button" className={styles.tile} style={imageUrl&&tile.bounds?{position:'absolute',left:`${tile.bounds.x/25}%`,top:`${tile.bounds.y/imageHeight*100}%`,width:`${tile.bounds.width/25}%`,height:`${tile.bounds.height/imageHeight*100}%`}:undefined} data-selected={selected === index || undefined} data-warned={warned.includes(tile.feature) || undefined} onClick={() => onSelect(index)} aria-label={tile.label}>{(initial||imageUrl)?<span className="sr-only">{tile.label}</span>:body}</button>
        ) : (
          <span key={tileKey} className={styles.tile} style={imageUrl&&tile.bounds?{position:'absolute',left:`${tile.bounds.x/25}%`,top:`${tile.bounds.y/imageHeight*100}%`,width:`${tile.bounds.width/25}%`,height:`${tile.bounds.height/imageHeight*100}%`}:undefined} data-selected={selected === index || undefined}>{(initial||imageUrl)?<span className="sr-only">{tile.label}</span>:body}</span>
        )
      })}
    </div>
  )
}

/** スマホの中の見本（wI4ZX の 1 台）。トークに友だち追加のあいさつ、下にリッチメニュー。 */
export function SampleMenuPhone({ style }: { style: AccountStyle }) {
  const menu = sampleMenuFor(style)
  return (
    <LinePreview title={null} accountName={menu.account} richMenu={<SampleMenuTiles style={style} size="phone" />}>
      <LinePreviewMessage accountName={menu.account} avatar={<span className={styles.avatar}><MusuboMark /></span>} time="10:00">{menu.greeting}</LinePreviewMessage>
    </LinePreview>
  )
}
