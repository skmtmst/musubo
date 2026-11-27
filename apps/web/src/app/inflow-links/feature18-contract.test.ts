import { readApiSource } from '../../../scripts/test-api-source.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = import.meta.dirname
const PAGE = readFileSync(join(ROOT, '../../v8/inflow-links/list.tsx'), 'utf8')
const ADS = ['ads.tsx', 'ad-connections.tsx', 'ad-history.tsx', 'ad-shared.ts'].map(file => readFileSync(join(ROOT, '../../v8/inflow-links', file), 'utf8')).join('\n')
const CREATE = readFileSync(join(ROOT, '../../v8/inflow-links/new/create.tsx'), 'utf8')
const DETAIL = readFileSync(join(ROOT, '../../v8/inflow-links/detail.tsx'), 'utf8')
const SITE = readFileSync(join(ROOT, '../../v8/inflow-links/site-script.tsx'), 'utf8')
const API = readApiSource(join(ROOT, '..', '..', 'lib', 'api.ts'), 'utf8')
const MOCK = readFileSync(join(ROOT, '..', '..', '..', '..', '..', 'scripts', 'visual-qa', 'mock-api.mjs'), 'utf8')

describe("管理画面 機能18の画面契約", () => {
  it('タブの件数は固定値でなく、一覧と同じ集計から出す(#980)', () => {
    // 設計が描いた作り物の件数を書かない。一覧0件のアカウントでも
    // 「流入経路 24」「広告連携 3」「広告とのつなぎ 5」と出ていた。
    expect(PAGE).not.toContain("label: '流入経路 24'")
    expect(PAGE).not.toContain("label: '広告連携 3'")
    expect(PAGE).not.toContain("label: '広告とのつなぎ 5'")
    // 「流入経路」は一覧が数える accountRows（FolderPanel の
    // 「すべて」と同じ集合）を、読み込めたときだけホストへ渡す。
    expect(PAGE).toContain('onRouteCountChange?.(routeCountAvailable ? accountRows.length : null)')
    // 「広告連携」「広告とのつなぎ」は、広告タブが一覧に使う platforms
    // と同じ集計（総数・動いている数）をホストへ渡す。
    expect(PAGE).toContain('const connected = res.data.filter((platform) => platform.isActive)')
    expect(PAGE).toContain('total: connected.length')
    expect(PAGE).toContain('value={adConnected ? adConnected.total : null}')
    // 取得前・失敗時は数字を出さない（null で件数を付けない）。
    expect(HOST).toContain('linksCount !== null')
    expect(PAGE).toContain('routeCountAvailable ? accountRouteCount : null')
  })

  it('各画面をPencilの実ノードと結び、未接続値を作らない', () => {
    expect(SITE).toContain('boardId="XjOte"')
    expect(ADS).toContain('boardId="qSTVR"')
    expect(ADS).toContain('boardId="FDBsG"')
    expect(ADS).toContain('boardId="p0kA3"')
    expect(CREATE).toContain('boardId="KMaMk"')
    expect(DETAIL).toContain('boardId="Q5le3"')
    expect(ADS).toContain('成果地点と、広告に返す名前の対応')
    // #514-14: 口はパスだけ返すため、死んでいる「知らないドメイン」判定と
    // 直書きの警告は出さない。届いたパスをそのまま出す。
    expect(SITE).not.toContain('知らないドメインが1つあります')
    expect(SITE).not.toContain("includes('unknown-')")
  })

  it('押せない準備中UIを機能18から除く', () => {
    for (const source of [PAGE, ADS, CREATE, DETAIL, SITE]) {
      expect(source).not.toContain('準備中')
    }
  })

  it('作成後は発行した一覧の行へ戻る', () => {
    // 現役V8はCreatePageと共通の戻り先を使う。
    expect(CREATE).toContain('発行して URL を受け取る')
    expect(CREATE).toContain("router.push(createPageReturnHref('/inflow-links', res.data.id))")
    expect(CREATE).toContain('見分けるための文字')
    expect(CREATE).toContain('お客さまはこの順に進みます')
  })

  it('詳細にはこの経路から来た友だちと本人確認の導線がある', () => {
    expect(DETAIL).toContain('/api/analytics/ref/${encodeURIComponent(routeRefCode)}')
    expect(DETAIL).toContain('この経路から来た友だち')
    expect(DETAIL).toContain('/friends/detail?id=${encodeURIComponent(friend.id)}')
  })
})

describe("管理画面 機能18の計測鍵の契約", () => {
  it('計測コードに固定の鍵を埋めない', () => {
    expect(API).not.toContain('hk_9f3a2c81b4')
  })

  it('計測鍵を対象アカウントの変更時に読み直し、API型を持つ', () => {
    expect(SITE).toContain('[selectedAccountId, keyAttempt]')
    expect(API).toContain('trackingKey: string')
  })

  it('画面確認の mock もアカウントごとに鍵を返す', () => {
    expect(MOCK).toContain("pathname === '/api/site/tracking-key'")
    expect(MOCK).toContain('trackingKey')
  })
})

const HOST = readFileSync(join(ROOT, 'page.tsx'), 'utf8')
