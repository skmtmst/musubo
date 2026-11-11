import { readUiSource as readFileSync } from '../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * Issue #670（監査6・画面別の磨き上げ13件）の横断契約。
 * 既存の画面別テストで守るもの（10 webinars / 20 analytics / 23 ec-commerce）
 * 以外の小粒な修正を、字面で見張る。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...parts: string[]) => readFileSync(join(HERE, ...parts), 'utf8')
/* 注釈中の言及に当たらないよう、コードだけにする */
const codeOf = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const CONTENTS = read('contents', 'page.tsx')
const AUTOMATIONS = read('automations', 'page.tsx')
const AUTO_REPLIES = read('auto-replies', 'page.tsx')
const AFFILIATES = read('..', 'v8', 'affiliates', 'affiliators.tsx')
const AFFILIATE_CSS = read('..', 'v8', 'affiliates', 'affiliates.module.css')
const BOOKING = read('booking', 'bookings', 'page.tsx')
const CHATS = read('chats', 'page.tsx')
const FRIENDS = read('friends', 'page.tsx')
const NOTIFY = read('line-notifications', 'page.tsx')
const NOTIFY_KPIS = read('..', 'v8', 'settings', 'line-notifications', 'customer-kpis.ts')
const WEBINARS = read('webinars', 'page.tsx')
const ANALYTICS = read('analytics', 'page.tsx')
const BOOKING_MENUS = read('booking', 'menus', 'page.tsx')
const TAG_ACTIONS = read('..', 'components', 'shared', 'action-list.tsx')
const TAG_REORDER = read('..', 'components', 'shared', 'reorder-handle.tsx')

describe('#670 15 登録メディアの札の操作は「…」にまとめる', () => {
  it('札にボタンを並べず、取得・編集・退避・削除は「…」の中へ集める', () => {
    const card = CONTENTS.slice(CONTENTS.indexOf('function MediaCardV8'))
    expect(card).toContain('<RowMenu')
    expect(card).toContain("label: 'ダウンロード'")
    expect(card).toContain("label: '削除する'")
    expect(card).toContain("qaOpen: 'YfTfJ'")

  })
})

describe('#670 25/09 オートメーションの状態と行高・ページ送り', () => {
  // 状態の手書きクラス固定は廃止。共通StatusBadgeと実画面で確認する。

  it('動いた記録はメニューへ移し、行の操作は編集＋…の1行に収める', () => {
    expect(AUTOMATIONS).toContain("id: 'runs'")
    expect(AUTOMATIONS).toContain("label: '動いた記録を見る'")
    expect(AUTOMATIONS).toContain('router.push(runsHref(item))')
    /* 閲覧のみの見るだけ導線は残す */
    expect(AUTOMATIONS).toContain('if (!canEdit) return [runs]')
  })

  // 単一頁も現在地と前後を出す。実DOMの頁送り試験が守る。

})

describe('#670 16/22 アフィリエイトの操作セルと緑文字', () => {
  it('計測中・停止中は状態の札で出し、操作セルに置かない', () => {
    expect(AFFILIATES).toContain("<StatusBadge tone={row.isActive ? 'success' : 'neutral'}>")
    const operationAt = AFFILIATES.indexOf('<Td className={styles.colOps}>')
    const operationEnd = AFFILIATES.indexOf('</Td>', operationAt)
    expect(operationAt).toBeGreaterThan(-1)
    expect(operationEnd).toBeGreaterThan(operationAt)
    expect(AFFILIATES.slice(operationAt, operationEnd)).not.toContain('計測中')
    expect(AFFILIATES.slice(operationAt, operationEnd)).not.toContain('停止中')
  })

  it('AA未満の緑を使わない', () => {
    expect(AFFILIATES).not.toContain('text-green-600')
    expect(AFFILIATES).not.toContain('text-emerald-600')
    expect(AFFILIATE_CSS).toMatch(/\.pill\[data-tone='active'\][^{]*\{[^}]*color: var\(--color-success\)/)
  })
})

describe('#670 17 予約一覧の押せない保存した条件を置かない', () => {
  it('準備中の死んだボタンを出さない', () => {
    expect(BOOKING).not.toContain('保存した条件は準備中です')
    expect(codeOf(BOOKING)).not.toContain('保存した条件')
  })
})

describe('#670 02 担当の二重ラベルと並び順の見出し', () => {
  it('受信箱の担当はプルダウンの自称だけにする', () => {
    expect(CHATS).not.toContain('<span className="shrink-0">担当者</span>')
    expect(read('..', 'components', 'shared', 'inbox-head-menus.tsx')).toContain('label="担当"')
  })
})

describe('#670 28 連動アクションのキーボード経路', () => {
  it('各行に上へ・下へがあり、同じ移動で動く', () => {
    expect(TAG_ACTIONS).toContain('const reorder = useReorder(')
    expect(TAG_REORDER).toContain("label: '上へ'")
    expect(TAG_REORDER).toContain("label: '下へ'")
  })

  it('つまみのドラッグも実際に動く', () => {
    expect(TAG_REORDER).toContain('draggable: true as const')
    expect(TAG_REORDER).toContain('onDrop: dragId')
    expect(TAG_ACTIONS).toContain('...reorder.handleProps(id)')
  })
})

describe('#670 22 残りのAA未満の緑を共通トークンへ', () => {
  it('success-bg の相手に green-700 を置かない', () => {
    expect(AUTOMATIONS).not.toContain('text-green-700')
  })
})

describe('#670 10 ウェビナー一覧の器は中身の高さに合わせる（A8）', () => {
  it('一覧の器に固定の最小高さを持たせない', () => {
    expect(WEBINARS).not.toContain('min-h-[360px]')
  })
})

describe('#670 20 分析の集計待ちは帯1本だけが理由を言う（A9）', () => {
  it('グラフ枠は理由文（stateReason）を繰り返さない', () => {
    expect(ANALYTICS).toContain('reasonShownInBanner')
  })
})

describe('#670 28 予約メニューに押せないドラッグ持ち手を置かない（A12）', () => {
  it('⠿ の飾りを行頭に出さない', () => {
    expect(BOOKING_MENUS).not.toContain('⠿')
  })

  it('並び順を変える実際の経路（編集内の数値欄）は残す', () => {
    expect(BOOKING_MENUS).toContain('label="並び順"')
  })
})

// 自動応答の 管理画面 の帯・凡例固定は廃止。V8の説明と札はV8の絵で確かめる。
