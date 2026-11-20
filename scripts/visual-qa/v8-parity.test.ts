/*
 * v8-parity の契約試験。ブラウザは要らない。
 *
 * 1. MEASURE_SCRIPT は関数式で、`page.evaluate(文字列)` は式を評価する
 *    だけで呼ばれない。呼ばないまま渡すと関数の値が返って `measured`
 *    が `undefined` になる。呼ぶ形（MEASURE_CALL）で渡す。
 * 2. compareAndWrite は `measured` が無いときも落とさない。
 * 3. 途中改行は Range の行数で数え、見えない・読み飛ばしは
 *    除く。省略（…）ははみ出しに数えない。
 * 4. 状態を開けない板（ダイアログ・確認・引き出し）は順位に入れない。
 * 5. 撮る前に context へ V8 テーマ＋偽ログインを置き、撮った絵が V8
 *    でなければ比べずに落とす。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { MEASURE_CALL, MEASURE_SCRIPT, PARITY_INIT, assertV8Theme, compareAndWrite, isNoStateBoard, shootUrl } from './v8-parity.mjs'
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { encodePng } from './v8-png.mjs'

function tinyPng(): Buffer {
  const rgba = Buffer.alloc(4 * 4 * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 200
    rgba[i + 1] = 210
    rgba[i + 2] = 220
    rgba[i + 3] = 255
  }
  return Buffer.from(encodePng({ width: 4, height: 4, rgba }))
}

function runCompare(measured: unknown) {
  const outDir = mkdtempSync(join(tmpdir(), 'v8-parity-'))
  const refPng = join(outDir, 'ref.png')
  const shot = tinyPng()
  writeFileSync(refPng, shot)
  const metrics = compareAndWrite({
    board: 'test',
    route: '/test',
    width: 1440,
    url: 'http://localhost:3101/test',
    refPng,
    refHtml: null,
    measured,
    shotBuffer: shot,
    outDir,
  })
  const saved = JSON.parse(readFileSync(join(outDir, 'metrics.json'), 'utf8'))
  return { metrics, saved }
}

describe('v8-parity の測り', () => {
  it('MEASURE_SCRIPT は関数式で、そのままでは測れない', () => {
    const bare = new Function(`return ${MEASURE_SCRIPT}`)()
    expect(typeof bare).toBe('function')
  })

  it('page.evaluate へは呼ぶ形で渡す', () => {
    expect(MEASURE_CALL).toBe(`(${MEASURE_SCRIPT})()`)
  })

  it('途中改行は高さ比べでなく行数で数える', () => {
    expect(MEASURE_SCRIPT).toContain('getClientRects')
    expect(MEASURE_SCRIPT).not.toContain('lineHeight')
  })

  it('古い世代名で除外せず、見えない・読み飛ばしは数えない', () => {
    const { Window } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('happy-dom')
    const browser = new Window()
    const document = browser.document
    const label = document.createElement('span')
    label.textContent = '測定対象'
    document.body.append(label)
    // happy-dom does not lay out text. Supply a wrapped rectangle as the measurement input;
    // selectors and visibility still run against the actual DOM, rather than source strings.
    label.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 50, bottom: 40, width: 50, height: 40 })
    const createRange = document.createRange.bind(document)
    document.createRange = () => {
      const range = createRange()
      range.getClientRects = () => [{}, {}]
      return range
    }
    const measure = () => runInNewContext(MEASURE_CALL, {
      document, window: browser, NodeFilter: browser.NodeFilter,
      getComputedStyle: browser.getComputedStyle.bind(browser),
    })
    try {
      label.className = 'v7-only'
      expect(measure().midWordBreaks).toHaveLength(1)
      label.style.display = 'none'
      expect(measure().midWordBreaks).toHaveLength(0)
      label.style.display = ''
      label.className = 'skipLink'
      expect(measure().midWordBreaks).toHaveLength(0)
    } finally {
      browser.close()
    }
  })

  it('省略（…）ははみ出しに数えない', () => {
    expect(MEASURE_SCRIPT).toContain("textOverflow === 'ellipsis'")
  })
})

describe('compareAndWrite は measured が無くても落ちない', () => {
  it.each([['undefined', undefined], ['null', null], ['空', {}]])('%s のとき空の配列で書く', (_label, measured) => {
    const { metrics, saved } = runCompare(measured)
    expect(metrics.overflows).toEqual([])
    expect(metrics.viewportOverflows).toEqual([])
    expect(metrics.midWordBreaks).toEqual([])
    expect(metrics.tableMisalignments).toEqual([])
    expect(metrics.fontIssues).toEqual([])
    expect(metrics.keyElements).toBe(0)
    expect(saved.keyElements).toBe(0)
  })

  it('ある分はそのまま数える', () => {
    const { metrics } = runCompare({
      overflows: [{ path: 'div.box', clientWidth: 100, scrollWidth: 120 }],
      viewportOverflows: [],
      midWordBreaks: [],
      tableMisalignments: [],
      fontIssues: [{ path: 'p', text: 'あ', font: 'sans' }],
      keys: [{ tag: 'h1', text: '保存', rect: { x: 0, y: 0, w: 10, h: 10 } }],
    })
    expect(metrics.overflows).toHaveLength(1)
    expect(metrics.fontIssues).toHaveLength(1)
    expect(metrics.keyElements).toBe(1)
    // 同じ絵同士で画素の差は 0。はみ出し10点＋書体2点だけ。
    expect(metrics.drift).toBe(12)
  })
})

describe('状態を開けない板は順位に入れない', () => {
  it('小窓は種別で分ける', () => {
    expect(isNoStateBoard({ kind: '小窓', name: 'テンプレート 削除（使っていない） V8' })).toBe(true)
  })

  it('ダイアログ・確認・引き出しは名前で分ける', () => {
    expect(isNoStateBoard({ kind: '画面', name: 'リマインダ 一時停止ダイアログ V8' })).toBe(true)
    expect(isNoStateBoard({ kind: '画面', name: 'LIFF 予約 ⑤ 確認' })).toBe(true)
    expect(isNoStateBoard({ kind: null, name: 'NEN配信 誕生日クーポンの決めごと（引き出し）V8' })).toBe(true)
  })

  it('ふつうの画面は順位に残す', () => {
    expect(isNoStateBoard({ kind: '画面', name: '友だち一覧' })).toBe(false)
    expect(isNoStateBoard({ kind: '画面', name: '' })).toBe(false)
    expect(isNoStateBoard(null)).toBe(false)
  })
})

/*
 * 本物のブラウザの代わりの stub。合言葉の置き場と V8 の確かめだけを見る。
 * 測り（MEASURE_CALL の文字列）はそのまま測り値を返す。
 */
function stubBrowser(theme: string | undefined, measured: unknown) {
  const calls: string[] = []
  let initFn: ((arg: unknown) => void) | null = null
  let initArg: unknown = null
  let fixedAt: Date | null = null
  const page = {
    clock: { setFixedTime: async (at: Date) => { fixedAt = at } },
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    evaluate: async (fnOrString: unknown) => {
      if (typeof fnOrString === 'function') {
        const g = globalThis as Record<string, unknown>
        const prev = g['document']
        g['document'] = { documentElement: { dataset: { theme } } }
        try {
          return (fnOrString as () => unknown)()
        } finally {
          g['document'] = prev
        }
      }
      return measured
    },
    screenshot: async () => Buffer.from([1, 2, 3]),
    close: async () => {},
  }
  const context = {
    addInitScript: async (fn: (arg: unknown) => void, arg: unknown) => {
      calls.push('addInitScript')
      initFn = fn
      initArg = arg
    },
    newPage: async () => {
      calls.push('newPage')
      return page
    },
    close: async () => {},
  }
  return {
    calls,
    fixedTime: () => fixedAt,
    runInit(store: Record<string, string>) {
      if (!initFn) throw new Error('合言葉が置かれていない')
      const g = globalThis as Record<string, unknown>
      const prev = g['localStorage']
      g['localStorage'] = { setItem: (k: string, v: string) => { store[k] = v } }
      try {
        initFn(initArg)
      } finally {
        g['localStorage'] = prev
      }
    },
    browser: {
      newContext: async () => {
        calls.push('newContext')
        return context
      },
      newPage: async () => {
        calls.push('browser.newPage')
        return page
      },
    },
  }
}

describe('撮る前に偽ログインを置く', () => {
  it('偽ログインの値と初回ポップアップの閉じた印だけを置く', () => {
    /*
     * 撮影は初回案内を閉じた状態から始める。重なった案内で本来見たい中身が
     * 隠れたり押せなくなるのを防ぐため。ポップアップ自体の見張り
     * （first-run-popup.*.spec.mjs）はこの印を外して出すので、ここで閉じても
     * ポップアップの表示・保存・読み直しの確認は失われない。
     */
    expect(PARITY_INIT).toEqual({
      lh_csrf: 'visual-qa-csrf',
      lh_staff_role: 'owner',
      lh_staff_name: 'K',
      lh_staff_permissions: '[]',
      lh_staff_view_permissions: '[]',
      lh_selected_account: 'visual-qa-account',
      lh_auth_selection_cleared: '1',
      'lh:v8:first-run-popup-dismissed:visual-qa-account': '1',
    })
  })

  it('context へ置いてから開く（browser 直開きはしない）', async () => {
    const stub = stubBrowser('v8', { keys: [] })
    const got = await shootUrl(stub.browser, 'http://localhost:3101', '/friends', 1440)
    expect(stub.calls).toEqual(['newContext', 'addInitScript', 'newPage'])
    expect(got.url).toBe('http://localhost:3101/friends')
    const store: Record<string, string> = {}
    stub.runInit(store)
    expect(store).toEqual(PARITY_INIT)
    expect(store).not.toHaveProperty('lh-admin-theme')
  })

  it('ROOT-14 予約とリマインダは見本サーバーと同じ時計で撮る', async () => {
    for (const route of ['/restaurant-test/reservations', '/reminders/edit?id=reminder-new']) {
      const stub = stubBrowser('v8', { keys: [] })
      await shootUrl(stub.browser, 'http://localhost:3101', route, 1440)
      expect(stub.fixedTime()?.toISOString()).toBe('2026-10-01T03:00:00.000Z')
    }
  })

  it('V8 でなければ比べずに落とす', async () => {
    expect(() => assertV8Theme('v8')).not.toThrow()
    expect(() => assertV8Theme('v7')).toThrow(/V8 で撮れていない/)
    expect(() => assertV8Theme(undefined)).toThrow(/V8 で撮れていない/)
    await expect(shootUrl(stubBrowser('v7', { keys: [] }).browser, 'http://localhost:3101', '/friends', 1440)).rejects.toThrow(/V8 で撮れていない/)
  })
})
