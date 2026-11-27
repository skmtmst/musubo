import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readImplementationSource } from '../../../../worker/src/test-utils/implementation-source'

const ROOT = import.meta.dirname
const PAGE = readFileSync(join(ROOT, '../../v8/inflow-links/list.tsx'), 'utf8')
const ADS = ['ads.tsx', 'ad-connections.tsx', 'ad-history.tsx', 'ad-shared.ts'].map(file => readFileSync(join(ROOT, '../../v8/inflow-links', file), 'utf8')).join('\n')
const CREATE = readFileSync(join(ROOT, '../../v8/inflow-links/new/create.tsx'), 'utf8')
const DETAIL = readFileSync(join(ROOT, '../../v8/inflow-links/detail.tsx'), 'utf8')
// 削除の窓は 管理画面・V8 の両方で使う共用部品へ移した（中身は同じ）。
// 削除の窓は詳細の画面（detail/page.tsx）の中にある。古い _components/inflow-delete-dialog.tsx はどこからも描かれないので 2026-10-07 に消した。
const DELETE_DIALOG = readFileSync(join(ROOT, '../../v8/inflow-links/detail.tsx'), 'utf8')
const MODAL = readFileSync(join(ROOT, '../../v8/inflow-links/edit-route-dialog.tsx'), 'utf8')
const SITE = readFileSync(join(ROOT, '../../v8/inflow-links/site-script.tsx'), 'utf8')
const LIFF = readImplementationSource(join(ROOT, '..', '..', '..', '..', 'worker', 'src', 'routes', 'liff.ts'))
const MOCK = readFileSync(join(ROOT, '..', '..', '..', '..', '..', 'scripts', 'visual-qa', 'mock-api.mjs'), 'utf8')
const FIXTURES = readFileSync(join(ROOT, '..', '..', '..', '..', '..', 'scripts', 'visual-qa', 'fixtures.mjs'), 'utf8')

describe('点検・中: 機能18 流入と計測(#514 の中 10 件、#565)', () => {
  it('#514-5: 編集窓は親の引いた所属名を使い、開くたび取り直さない', () => {
    expect(MODAL).toContain('poolMemberNames')
    expect(MODAL).toContain('if (poolMemberNames)')
    expect(PAGE).toContain('poolMemberNames={poolMemberNames}')
  })

  it('#514-6: 媒体横断の送信履歴を共通一覧口から20件ずつ取得する', () => {
    expect(ADS).toContain('LOG_PAGE_SIZE')
    expect(ADS).toContain('Pagination')
    expect(ADS).toContain('api.adPlatforms.logsPage')
    expect(ADS).toContain('setTotal(logRes.data.total)')
    expect(ADS).not.toContain('response.data.map((platform) => api.adPlatforms.logs')
  })

  it('#514-7: 存在しない短縮 URL(/s/)を出さない', () => {
    expect(CREATE).not.toContain('shortUrl')
    expect(CREATE).not.toContain('短いほう')
    expect(CREATE).toContain('/r/${refCode')
  })

  it('#514-8: 口の返す欄だけ読み、無い欄は「—」にする', () => {
    // 口は currentStatus を返す(友だち中・ブロック済み)。firstPage・conversion・miles は返さない。
    expect(LIFF).toContain("currentStatus: f.is_following === 0 ? 'ブロック済み' : '友だち中'")
    expect(DETAIL).toContain("friend.currentStatus ?? emptyValue('unknown')")
    expect(DETAIL).toContain("friend.conversion ?? emptyValue('unknown')")
    expect(DETAIL).not.toContain("currentStatus ?? '取得できません'")
    expect(DETAIL).not.toContain("conversion ?? '取得できません'")
    // 広告履歴は口の無い friendName・conversionName・nextRetryAt を読まない。
    expect(ADS).not.toContain('extraText')
    expect(ADS).toContain("log.status === 'pending' ? '送信待ち'")
    expect(ADS).not.toContain('11:35 に送ります')
  })

  it('#514-9: 撮影モックに計測リンクと本番形の ref 詳細がある', () => {
    expect(MOCK).toContain("pathname === '/api/tracked-links'")
    expect(MOCK).toContain('TRACKED_LINKS')
    expect(FIXTURES).toContain('export const TRACKED_LINKS')
    // ref 詳細は refCode・name・本番形の友だちだけ。豊富な形は持たせない。
    expect(MOCK).toContain("currentStatus: '友だち中'")
    expect(MOCK).not.toContain("currentStatus: 'やりとり中'")
    expect(MOCK).not.toContain("conversion: 'まだありません'")
  })

  it('#514-10: ref の受付を口と同じ [A-Za-z0-9_-]{1,64} に寄せる', () => {
    expect(CREATE).toContain('/^[A-Za-z0-9_-]{1,64}$/')
    expect(CREATE).toContain('半角英数字・_・ハイフンで1〜64文字')
  })

  it('#514-11: 転送先の自動採用はしない(#1366 で対応済みの確認)', () => {
    // 削除フローは転送先の選択を必須にする。先頭の自動採用は無い。
    expect(DELETE_DIALOG).toContain('転送先のリンクを選んでください')
    expect(DELETE_DIALOG).not.toContain('routes.find((candidate) => candidate.id !== route.id)')
  })

  it('#514-12: 段階の失敗は文と再読み込みで返し、読み込み中のままにしない', () => {
    expect(DETAIL).toContain('funnelError')
    expect(DETAIL).toContain('段階を再読み込み')
    expect(DETAIL).toContain('段階を読み込めませんでした')
  })

  it('#514-13: 押しても何も起きないボタンを出さない', () => {
    // 詳細の「この経路を編集」は編集窓を開く。
    expect(DETAIL).toContain('setEditingRoute(true)')
    expect(DETAIL).toContain('<EditRouteModal')
    // 広告タブの効かない操作ボタンは出さない。
    for (const dead of ['失敗したものをまとめてやり直す</Button>', '対応を変える', '対応を付ける', '設定を見る</Button>', '中身を見る</Button>', 'つなぐ</Button>']) {
      expect(ADS).not.toContain(dead)
    }
    // 失敗理由は口の errorMessage を開いて見せる。
    expect(ADS).toContain('断られた理由：${log.errorMessage}')
    expect(ADS).toContain('log.errorMessage')
  })

  it('#514-13: 口から取れない数を書かない', () => {
    for (const fixed of ['1545', '11476', '前月 ¥438,000', '8/25 11:20 に同期', '8/25 06:00 に取り込みました', '夏キャンペーン（検索）', '体験申込フォームの送信\',\'Lead']) {
      expect(ADS).not.toContain(fixed)
    }
    expect(ADS).toContain("emptyValue('unknown')")
  })

  it('#514-14: 計測先ホストとパスを口から受け取って表示する', () => {
    expect(SITE).not.toContain('unknown-')
    expect(FIXTURES).toContain("{ host: 'shop.example.com', path: '/', views:")
    expect(FIXTURES).not.toContain("path: 'https")
  })
})
