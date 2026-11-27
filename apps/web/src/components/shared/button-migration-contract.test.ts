import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { readDesignImpactBaseline } from '../../../scripts/design-impact-baseline.mjs'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const targets = readDesignImpactBaseline().buttonMigrationTargets
const sources = Object.fromEntries(
  targets.map((path) => [path, readFileSync(join(SRC, path), 'utf8')]),
)

function buttonOpenings(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const openings: string[] = []
  const walk = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(file) === 'Button'
    ) {
      openings.push(node.getText(file))
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return openings
}

describe('標準ボタンの第1段階移行', () => {
  it('一覧に登録した画面の標準操作を共通Buttonで維持する', () => {
    const openings = Object.entries(sources).flatMap(([path, source]) => {
      expect(source, `${path} が共通Buttonを直接importしていない`).toContain(
        "import Button from '@/components/shared/button'",
      )
      const inFile = buttonOpenings(path, source)
      expect(inFile, `${path} に共通Buttonの利用箇所が無い`).not.toHaveLength(0)
      return inFile
    })

    // 紹介者一覧の空状態にも、共通Buttonの作成操作を追加した。
    // 2026-08-28: 分析管理画面の保存結果を、名前を付けて保存できるようにした。
    // 未実装のCSV・定期レポート操作は数へ入れない。
    // 2026-08-30: 「使われ方」から中身の確認・片づけへ進む2操作を追加した。
    // 2026-09-02: 成果地点と流入経路を設計へ寄せた分を、最新 development
    // と統合した木で再計測して37個・主要15個へ締め直した。
    //   - 押せない「CSVで書き出す」を外した（口が無い）: −1
    //   - 取得失敗の状態に「再読み込み」を足した（2画面）: +2
    //   - 流入経路の「このフォルダにURLを発行」を直書きから共通Buttonへ: +1
    //     この1つが primary なので 14 → 15。
    // 同日: 案件タブのCSV・再読み込み・空状態からの作成を統合し、
    // 実際の7ルートを再計測して40個・主要16個へ締め直した。
    // 2026-09-02: /tags の見張り先を、描かれない旧V5の枝からV4本体へ移した。
    // 旧枝の6個（うち主要3個）が消え、V4本体の5個（うち主要3個）が入る。
    // 2026-09-02: #433 の使用先確認と質問作成は development 側で増えている。
    // **片方を選ぶともう片方の増減が数から消える**ので、統合後の木で数え直した。
    // 2026-09-02: テンプレート一覧の取得失敗は主要操作ではなく、状態表示の
    // 「再読み込み」として副次操作へ寄せた。統合後の木で主要16個を実測した。
    // 2026-09-04: テンプレート一覧のフォルダ帯を共通 `FolderPanel` へ寄せ、
    // 「フォルダを追加」を共通 Button にした。41 → 42。
    // 2026-09-04: 流入経路の一覧へ「CSVで書き出す」を1つ追加（設計 `Q4bkTg`）。
    //   development 側で口が無いまま置かれていたものを一度外してあり、
    //   今回は**押すと実際に書き出せる**ものとして戻す。42 → 43。
    // 2026-09-04: 取得失敗の再読み込み2個は、画面ごとの `action` から
    // `ListState.onRetry` へ移した。共通部品が描くので、この7ルートでは数えない。
    // 2026-09-06: 機能18の一覧に、設計で必要なCSVとまとめて操作を戻した。
    // どちらも共通Buttonを使い、39 → 41。
    expect(openings.some((opening) => opening.includes('variant="primary"'))).toBe(true)
  })

  it('共通部品が持つ見た目を画面側で重ねない', () => {
    // V8 移行 ①: 直書きボタンを共通 Button へ置き換える際、画面の見た目を
    // 変えないために px-/py-/text-*/font-*/min-h- 等のレイアウト・寸法クラスは
    // 残す（部品の既定値への意図的な上書き）。禁止するのは variant と同値の
    // クラスの再指定だけ——静的な className で部品の役割を二重に書くのを防ぐ。
    // 動的 className（${} 入り）は条件で見た目を切り替える正当な利用なので対象外。
    // 別variantの色は意図的な上書き。同じvariantが持つ値だけを禁止する。
    const duplicatesByVariant: Record<string, RegExp> = {
      primary: /\b(?:bg-accent-deep|text-on-accent|hover:brightness-92)\b/,
      secondary: /\b(?:border-hairline|bg-canvas|hover:bg-canvas-sunken)\b/,
      danger: /\b(?:bg-danger|text-on-accent)\b/,
      ghost: /\bhover:bg-canvas-sunken\b/,
    }

    for (const [path, source] of Object.entries(sources)) {
      for (const opening of buttonOpenings(path, source)) {
        const cls = /className="([^"]*)"/.exec(opening)?.[1]
        if (!cls) continue
        const variant = /variant="([^"]+)"/.exec(opening)?.[1] ?? 'secondary'
        expect(cls, `${path} が共通Buttonの丸みを重ねている`).not.toMatch(/\brounded-control\b/)
        const duplicates = duplicatesByVariant[variant]
        if (duplicates) {
          expect(cls, `${path} が共通Buttonへ variant と同値の指定を重ねている`).not.toMatch(duplicates)
        }
      }
    }
  })

  it('リンク先と主要な操作ハンドラを維持する', () => {
    // 案件の作成は現役V8の窓へ移った。入口と実際に窓を開く処理を守る。
    const offers = readFileSync(join(SRC, 'v8/affiliates/offers.tsx'), 'utf8')
    expect(offers).toContain('const openCreate = () => { setEditTarget(null); setFormOpen(true) }')
    const create = readFileSync(join(SRC, 'v8/affiliates/create.tsx'), 'utf8')
    expect(create).toContain("onClick={() => void runSave('finish')}")
    expect(create).toContain('const affiliateId = await save()')
    expect(create).toContain('<Button href={LIST_PATH}>キャンセル</Button>')
    // キャンセル操作は ui-footer-guard.test.tsx で処理中と待機中を確認する。
  })
})
