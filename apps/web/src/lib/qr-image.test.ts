import { readUiSource } from '../../scripts/test-ui-source.mjs'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

/*
 * PERF-09: qrcode は QR を画面へ出す瞬間にだけ読む。
 * QR を一度も開かない訪問の初期バンドルへ入れないため、画面側は
 * すべて `qr-image` の動的読み込みへ通し、静的 import を残さない。
 */
const SRC = path.join(__dirname, '..')
const QR_PAGES = [
  'components/dashboard/qr-dialog.tsx',
  'components/hq/notice-line-register-dialog.tsx',
  'v8/ops/two-factor.tsx',
  'v8/settings/staff/staff.tsx',
  'app/login/two-factor/setup/page.tsx',
]

describe('QRライブラリの表示時読み込み(PERF-09)', () => {
  it('流入リンク作成は発行した行へ戻り、QRはWorkerの画像を使う', () => {
    const create = fs.readFileSync(path.join(SRC, 'v8/inflow-links/new/create.tsx'), 'utf8')
    expect(create).toContain("router.push(createPageReturnHref('/inflow-links', res.data.id))")
    const dialog = fs.readFileSync(path.join(SRC, 'v8/inflow-links/qr-dialog.tsx'), 'utf8')
    expect(dialog).toContain('<DashboardQrDialog')
    expect(dialog).toContain('baseLink={referralUrl(route.refCode)}')
    expect(dialog).toContain('stopped: route.isActive === false')
    expect(dialog).toContain('api.entryRoutes.qrImage')
    expect(dialog).not.toMatch(/from\s+['"]qrcode['"]/)
  })
  it('QRを出す画面が qrcode を静的に import していない', () => {
    for (const rel of QR_PAGES) {
      const source = readUiSource(path.join(SRC, rel), 'utf8') + (rel === 'components/hq/notice-line-register-dialog.tsx'
        ? readUiSource(path.join(SRC, 'v8/hq/notice-line-dialog.tsx'), 'utf8') : '')
      expect(source, rel).not.toMatch(/import\s+QRCode\s+from\s+['"]qrcode['"]/)
      expect(source, rel).not.toMatch(/from\s+['"]qrcode['"]/)
      expect(source, rel).toContain('qr-image')
    }
  })

  it('読み込み口は1箇所だけで、表示時の動的 import に集約されている', () => {
    const helper = fs.readFileSync(path.join(SRC, 'lib/qr-image.ts'), 'utf8')
    expect(helper).toContain("import('qrcode')")
    // 型だけの参照は消えるので静的 import は許さない（import type は可）。
    expect(helper).not.toMatch(/^import\s+QRCode\s+from\s+['"]qrcode['"]/m)
  })

  it('qrToDataURL は qrcode の読み込みを1回に束ね、以後は使い回す', async () => {
    vi.resetModules()
    let loads = 0
    vi.doMock('qrcode', () => {
      loads += 1
      return { default: { toDataURL: vi.fn(async () => 'data:image/png;base64,x') } }
    })
    const { qrToDataURL } = await import('./qr-image')
    const [a, b] = await Promise.all([qrToDataURL('x'), qrToDataURL('y')])
    expect(a).toBe('data:image/png;base64,x')
    expect(b).toBe('data:image/png;base64,x')
    expect(loads).toBe(1)
    vi.doUnmock('qrcode')
  })
})
