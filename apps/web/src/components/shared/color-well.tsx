'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, Pipette } from 'lucide-react'
import styles from './color-well.module.css'
import { isImeComposing } from './ime'
import Notice from './notice'
import MenuPortal from './menu-portal'


const HEX6 = /^#[0-9a-fA-F]{6}$/
const HEX8 = /^#[0-9a-fA-F]{8}$/

type Hsv = { h: number; s: number; v: number }

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
const clamp = (n: number, min: number, max: number) => (n < min ? min : n > max ? max : n)

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX6.test(hex) && !HEX8.test(hex)) return null
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const part = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : (d / max) * 100, v: max * 100 }
}

function hsvToRgb({ h, s, v }: Hsv): { r: number; g: number; b: number } {
  const sn = s / 100
  const vn = v / 100
  const c = vn * sn
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = vn - c
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 }
}

/** `#rrggbb` / `#rrggbbaa` / null を、面と不透明度の状態に開く。 */
function parseValue(value: string | null | undefined): { hsv: Hsv; alpha: number } {
  const rgb = value ? hexToRgb(value) : null
  if (!rgb) return { hsv: { h: 0, s: 0, v: 100 }, alpha: 100 }
  const alpha =
    value && HEX8.test(value) ? Math.round((Number.parseInt(value.slice(7, 9), 16) / 255) * 100) : 100
  return { hsv: rgbToHsv(rgb.r, rgb.g, rgb.b), alpha }
}

/** 面と不透明度を、保存する文字列へ畳む（不透明なら 6 桁）。 */
function composeValue(hsv: Hsv, alpha: number): string {
  const { r, g, b } = hsvToRgb(hsv)
  const base = rgbToHex(r, g, b)
  if (alpha >= 100) return base
  const a = Math.round((clamp(alpha, 0, 100) / 100) * 255)
    .toString(16)
    .padStart(2, '0')
  return `${base}${a}`
}

/** 正規化（`rrggbb` や大文字でも受ける）。読めないときは null。 */
function normalizeHex(input: string): string | null {
  const text = input.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(text) && !/^[0-9a-fA-F]{8}$/.test(text)) return null
  return `#${text.toLowerCase()}`
}

/** V8 正本の「よく使う色」（8×3）。v8 の画面ではこちらを並べる。 */
const V8_COLORS = [
  '#0f172a', '#475569', '#94a3b8', '#64748b', '#cbd5e1', '#f1f5f9',
  '#ef4444', '#f97316', '#fbbf24', '#16a34a', '#06c755', '#087a3e',
  '#84cc16', '#22d3ee', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef',
  '#ec4899', '#f43f5e', '#fda4af', '#1d1d1f', '#626a73', '#dadde2',
]

/**
 * 色を選ぶ（Pencil ★V8 `KVkPg` ／開いた状態 ★BG-2 `P8ZUj`・`d6PU4a`）。
 *
 * 今の色の見本＋区切り線＋矢印の 36px のコントロール。押すと下にピッカーが
 * 開く。中身は、色の種類（単色）の見出し、彩度・明度の面、色相と不透明度の
 * バー、十六進と不透明度の入力、スポイト、よく使う色、このデザインの色、
 * そして「指定なしに戻す」「この色にする」。
 *
 * 操作はその場で反映する（面やバーを動かすと呼び出し元の色も変わる）ので、
 * 「この色にする」は確定して閉じるだけ、「指定なしに戻す」は色を外す。
 */
export default function ColorWell({
  value,
  onChange,
  colors,
  label = '色を選ぶ',
  disabled = false,
  allowAlpha = true,
  allowClear = true,
  savedColors,
  onSaveColor,
  block = false,
  fallback = '#ffffff',
  retainInvalidInput = false,
}: {
  /** 書きかけを消さず、誤ったコードは直してから確定してもらう。 */
  retainInvalidInput?: boolean
  /** 今の色（`#rrggbb`／半透明なら `#rrggbbaa`）。指定なしは null。 */
  value: string | null
  onChange: (color: string | null) => void
  /** 格子に並べる色。渡さないときは DEFAULT_COLORS。 */
  colors?: string[]
  label?: string
  disabled?: boolean
  /** 不透明度のバーと入力を出すか。 */
  allowAlpha?: boolean
  /** 「指定なしに戻す」を出すか。 */
  allowClear?: boolean
  /** このデザインの色（保存済み）。 */
  savedColors?: string[]
  /** 「＋この色を保存」を押したとき。渡すと保存の欄が出る。 */
  onSaveColor?: (color: string) => void
  /** 横幅を親に合わせる（Pencil ★BG-B `KkTNS` の 2 列並び用）。 */
  block?: boolean
  /** 指定なしのときにピッカーを開く色（★BG-B の役割ごとの見本の色）。 */
  fallback?: string
}) {

  const palette = colors ?? (V8_COLORS)
  const [open, setOpen] = useState(false)
  const initial = parseValue(value ?? fallback)
  const [hsv, setHsv] = useState<Hsv>(initial.hsv)
  const [alpha, setAlpha] = useState(initial.alpha)
  const [hexText, setHexText] = useState((value ?? fallback).replace(/^#/, '').slice(0, 6))
  const [hexError, setHexError] = useState(false)
  const emitted = useRef<string | null>(value ?? null)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const hasDropper = typeof window !== 'undefined' && 'EyeDropper' in window

  // 呼び出し元が外から色を変えたときだけ、面と入力を作り直す。
  useEffect(() => {
    if ((value ?? null) === emitted.current) return
    emitted.current = value ?? null
    const next = parseValue(value ?? fallback)
    setHsv(next.hsv)
    setAlpha(next.alpha)
    setHexText((value ?? fallback).replace(/^#/, '').slice(0, 6))
  }, [value, fallback])

  const solid = composeValue(hsv, 100)
  const current = composeValue(hsv, allowAlpha ? alpha : 100)

  const emit = (nextHsv: Hsv, nextAlpha: number) => {
    const next = composeValue(nextHsv, allowAlpha ? nextAlpha : 100)
    emitted.current = next
    setHexText(next.slice(1, 7))
    onChange(next)
  }

  const updateHsv = (next: Hsv) => {
    setHsv(next)
    emit(next, alpha)
  }

  const updateAlpha = (next: number) => {
    const bounded = Math.round(clamp(next, 0, 100))
    setAlpha(bounded)
    emit(hsv, bounded)
  }

  const applyHex = (input: string) => {
    const hex = normalizeHex(input)
    if (!hex) {
      if (retainInvalidInput) { setHexError(true); return }
      setHexText(value ? value.slice(1, 7) : '')
      return
    }
    const rgb = hexToRgb(hex)
    setHexError(false)
    if (!rgb) return
    const nextHsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
    const nextAlpha = HEX8.test(hex) ? Math.round((Number.parseInt(hex.slice(7, 9), 16) / 255) * 100) : alpha
    setHsv(nextHsv)
    setAlpha(nextAlpha)
    emit(nextHsv, nextAlpha)
  }

  /** 面を押した位置から彩度・明度を読む。 */
  const readPlane = (element: HTMLElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    updateHsv({
      ...hsv,
      s: clamp01((clientX - rect.left) / rect.width) * 100,
      v: (1 - clamp01((clientY - rect.top) / rect.height)) * 100,
    })
  }

  /** バーを押した位置から 0〜max を読む。 */
  const readBar = (element: HTMLElement, clientX: number, max: number) => {
    const rect = element.getBoundingClientRect()
    if (!rect.width) return null
    return clamp01((clientX - rect.left) / rect.width) * max
  }

  const capture = (event: ReactPointerEvent<HTMLElement>) => {
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        /* 捕まえられない環境では押した位置だけ読む */
      }
    }
  }

  const pickWithDropper = async () => {
    try {
      const dropper = new (
        window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }
      ).EyeDropper()
      const { sRGBHex } = await dropper.open()
      applyHex(sRGBHex)
    } catch {
      /* ユーザがキャンセルした */
    }
  }

  const showSaved = onSaveColor !== undefined || (savedColors?.length ?? 0) > 0

  return (
    <span ref={rootRef} className={block ? `${styles.root} ${styles.rootBlock}` : styles.root}>
      <button
        type="button"
        className={styles.well}
        aria-label={`${label}（今の色 ${value ?? '指定なし'}）`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          setOpen(true)
        }}
      >
        <span
          className={value ? styles.swatch : `${styles.swatch} ${styles.swatchEmpty}`}
          style={value ? { backgroundColor: value } : undefined}
          aria-hidden="true"
        />
        {/* 呼び出し元には今の色を文字でも出す（Pencil `xeedd` の「値」）。 */}
        <span className={styles.wellValue} aria-hidden="true">
          {value ? value.toUpperCase() : '指定なし'}
        </span>
        <span className={styles.divider} aria-hidden="true" />
        <ChevronDown size={16} aria-hidden="true" className={styles.caret} />
      </button>
      <MenuPortal open={open} getAnchor={() => rootRef.current?.querySelector('button') ?? null} onClose={() => setOpen(false)} align="start" gap={6} className={styles.pop}>
        <div className={styles.popContent} role="dialog" aria-label={label}>
          {/*
            色の種類の見出し。承認した見た目（★BG-2 `P8ZUj`）には「単色／
            グラデーション」の2つのタブが並ぶが、グラデーションはまだ扱えない
            （色は `#RRGGBB(AA)` の1色で持っているため）。共通ルール 2-2・5-5
            の「押せないものを完成画面に置かない／そもそも描かない」に従って、
            押せないタブは出さず、ここが単色を選ぶ場所だと分かる見出しだけ置く。
            グラデーションを扱えるようにするときにタブへ戻す。
          */}
          <div className={styles.tabs}>
            <span className={`${styles.tab} ${styles.tabOn}`}>単色</span>
          </div>

          {/* 彩度・明度の面 */}
          <div
            className={styles.plane}
            role="slider"
            tabIndex={0}
            aria-label="鮮やかさと明るさ"
            /*
             * 面は横に鮮やかさ・縦に明るさの2方向。読み上げには両方を
             * `aria-valuetext` で伝えるが、`slider` は数値も必須なので
             * 横方向（鮮やかさ）を `aria-valuenow` に出す。
             */
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsv.s)}
            aria-valuetext={`鮮やかさ ${Math.round(hsv.s)}％・明るさ ${Math.round(hsv.v)}％`}
            style={{
              background: `linear-gradient(to top, #000000, rgba(0,0,0,0)), linear-gradient(to right, #ffffff, rgba(255,255,255,0)), hsl(${hsv.h} 100% 50%)`,
            }}
            onPointerDown={(event) => {
              capture(event)
              readPlane(event.currentTarget, event.clientX, event.clientY)
            }}
            onPointerMove={(event) => {
              if (event.buttons !== 1) return
              readPlane(event.currentTarget, event.clientX, event.clientY)
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 10 : 2
              if (event.key === 'ArrowLeft') updateHsv({ ...hsv, s: clamp(hsv.s - step, 0, 100) })
              else if (event.key === 'ArrowRight') updateHsv({ ...hsv, s: clamp(hsv.s + step, 0, 100) })
              else if (event.key === 'ArrowDown') updateHsv({ ...hsv, v: clamp(hsv.v - step, 0, 100) })
              else if (event.key === 'ArrowUp') updateHsv({ ...hsv, v: clamp(hsv.v + step, 0, 100) })
              else return
              event.preventDefault()
            }}
          >
            <span
              className={styles.planeHandle}
              style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, backgroundColor: solid }}
            />
          </div>

          {/* 現在色・色相・不透明度 */}
          <div className={styles.sliders}>
            <span className={styles.current} style={{ backgroundColor: current }} aria-hidden="true" />
            <div className={styles.bars}>
              <div
                className={styles.bar}
                role="slider"
                tabIndex={0}
                aria-label="色あい"
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={Math.round(hsv.h)}
                style={{
                  background:
                    'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
                }}
                onPointerDown={(event) => {
                  capture(event)
                  const next = readBar(event.currentTarget, event.clientX, 360)
                  if (next !== null) updateHsv({ ...hsv, h: next })
                }}
                onPointerMove={(event) => {
                  if (event.buttons !== 1) return
                  const next = readBar(event.currentTarget, event.clientX, 360)
                  if (next !== null) updateHsv({ ...hsv, h: next })
                }}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 20 : 4
                  if (event.key === 'ArrowLeft') updateHsv({ ...hsv, h: clamp(hsv.h - step, 0, 360) })
                  else if (event.key === 'ArrowRight') updateHsv({ ...hsv, h: clamp(hsv.h + step, 0, 360) })
                  else return
                  event.preventDefault()
                }}
              >
                <span
                  className={styles.barThumb}
                  style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
                />
              </div>
              {allowAlpha ? (
                <div
                  className={styles.bar}
                  role="slider"
                  tabIndex={0}
                  aria-label="すけ具合"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={alpha}
                  style={{
                    background: `linear-gradient(to right, rgba(255,255,255,0), ${solid}), repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%) 50% / 8px 8px`,
                  }}
                  onPointerDown={(event) => {
                    capture(event)
                    const next = readBar(event.currentTarget, event.clientX, 100)
                    if (next !== null) updateAlpha(next)
                  }}
                  onPointerMove={(event) => {
                    if (event.buttons !== 1) return
                    const next = readBar(event.currentTarget, event.clientX, 100)
                    if (next !== null) updateAlpha(next)
                  }}
                  onKeyDown={(event) => {
                    const step = event.shiftKey ? 10 : 2
                    if (event.key === 'ArrowLeft') updateAlpha(alpha - step)
                    else if (event.key === 'ArrowRight') updateAlpha(alpha + step)
                    else return
                    event.preventDefault()
                  }}
                >
                  <span className={styles.barThumb} style={{ left: `${alpha}%`, backgroundColor: current }} />
                </div>
              ) : null}
            </div>
          </div>

          {/* 十六進・不透明度・スポイト */}
          <div className={styles.inputs}>
            <label className={styles.hexField}>
              <span className={styles.hexMark} aria-hidden="true">
                #
              </span>
              {/* v8 は正本どおり大文字で見せる。入力中の文字は hexText のまま持つ。 */}
              <input
                className={styles.hexInput}
                value={hexText.toUpperCase()}
                aria-label="色を十六進で入力"
                aria-invalid={hexError || undefined}
                onChange={(event) => { setHexText(event.target.value.replace(/^#/, '')); setHexError(false) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || isImeComposing(event)) return
                  event.preventDefault()
                  applyHex(hexText)
                }}
                onBlur={() => applyHex(hexText)}
              />
            </label>
            {allowAlpha ? (
              <label className={styles.alphaField}>
                <input
                  className={styles.alphaInput}
                  value={String(alpha)}
                  inputMode="numeric"
                  aria-label="すけ具合を数字で入力"
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value.replace(/[^0-9]/g, ''), 10)
                    updateAlpha(Number.isNaN(next) ? 0 : next)
                  }}
                />
                <span className={styles.unit} aria-hidden="true">
                  %
                </span>
              </label>
            ) : null}
            {/* v8 は正本どおりスポイトを必ず置き、対応していないブラウザでは押せない形で出す。 */}
            {(
              <button
                type="button"
                className={styles.dropper}
                aria-label="画面の色をすくう"
                disabled={!hasDropper}
                title={!hasDropper ? 'このブラウザはスポイトに対応していません' : undefined}
                onClick={() => void pickWithDropper()}
              >
                <Pipette size={16} aria-hidden="true" />
              </button>
            )}
          </div>

          <span className={styles.rule} aria-hidden="true" />

          {/* よく使う色 */}
          <div className={styles.group}>
            <span className={styles.headingText}>よく使う色</span>
            {hexError ? <Notice tone="warn" role="alert">6桁の16進数で色を入力してください。</Notice> : null}
            <div className={styles.grid} role="listbox" aria-label="よく使う色">
              {palette.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="option"
                  aria-selected={color.toLowerCase() === (value ?? '').toLowerCase()}
                  aria-label={color}
                  className={
                    color.toLowerCase() === (value ?? '').toLowerCase() ? `${styles.cell} ${styles.cellOn}` : styles.cell
                  }
                  style={{ backgroundColor: color }}
                  onClick={() => applyHex(color)}
                />
              ))}
            </div>
          </div>

          {showSaved ? (
            <>
              <span className={styles.rule} aria-hidden="true" />
              <div className={styles.group}>
                <div className={styles.heading}>
                  <span className={styles.headingText}>このデザインの色</span>
                  {onSaveColor ? (
                    <button type="button" className={styles.save} onClick={() => onSaveColor(current)}>
                      ＋この色を保存
                    </button>
                  ) : null}
                </div>
                {(savedColors?.length ?? 0) > 0 ? (
                  <div className={styles.savedRow} role="listbox" aria-label="このデザインの色">
                    {savedColors?.map((color) => (
                      <button
                        key={color}
                        type="button"
                        role="option"
                        aria-selected={color.toLowerCase() === (value ?? '').toLowerCase()}
                        aria-label={color}
                        className={styles.saved}
                        style={{ backgroundColor: color }}
                        onClick={() => applyHex(color)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {/* 指定なしに戻す／この色にする */}
          <div className={styles.footer}>
            {allowClear ? (
              <button
                type="button"
                className={styles.clear}
                onClick={() => {
                  emitted.current = null
                  onChange(null)
                  setOpen(false)
                }}
              >
                指定なしに戻す
              </button>
            ) : null}
            <button
              type="button"
              className={styles.apply}
              onClick={() => {
                emit(hsv, alpha)
                setOpen(false)
              }}
            >
              この色にする
            </button>
          </div>
        </div>
      </MenuPortal>
    </span>
  )
}
