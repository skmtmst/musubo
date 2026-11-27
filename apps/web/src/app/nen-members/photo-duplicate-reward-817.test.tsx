// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhotoReviewDetail } from '@/v8/nen-posts/detail'

/*
 * #817: 写真の重複と報酬の決まりの版。主な状態を描画で確かめる。
 *
 * - 重複なし：帯は出さず、このまま採用が主役。
 * - 重複あり：帯と前の投稿の並びが出て、選べるのは却下か報酬なしで採用。
 *   主役の緑ボタンは1つだけ（報酬なしで採用）。
 *
 * 2026-10-07：報酬の決まりの小箱（photo-reward-policy.tsx）はどの画面からも描かれないので消し、
 * その試験も外した。今の投稿画面（photo-review-v8.tsx）は小箱を持たず、外枠の「版の履歴を見る」で版を出す。
 */

vi.mock('next/link', () => ({ default: () => null }))

const VERSIONS = [
  {
    versionNumber: 2, policyKey: 'v2', points: 10, summary: '報酬を5pt→10ptに',
    effectiveFrom: null, createdBy: 'owner-1',
    createdAt: '2026-09-25T20:40:00+09:00', status: 'in_use',
  },
  {
    versionNumber: 1, policyKey: 'legacy-5', points: 5, summary: '最初の報酬の決まり',
    effectiveFrom: null, createdBy: null,
    createdAt: '2026-07-28T18:15:00+09:00', status: 'past',
  },
]

let policyMode: 'ok' | 'error' | 'pending' = 'ok'

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    if (path.startsWith('/api/nen-members/photo-reward-policy/versions')) {
      if (policyMode === 'error') {
        return new Response(JSON.stringify({ success: false, error: '読み込めません' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (policyMode === 'pending') {
        await new Promise(() => {})
      }
      return new Response(JSON.stringify({ success: true, data: VERSIONS }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`未設定: ${path}`)
  })
}

function basePhoto(): Record<string, unknown> {
  return {
    id: 'photo-new', pet_name: 'モカ', pet_call_name: 'モカちゃん', pet_gender: 'female',
    owner_name: '飼い主', caption: '', status: 'pending',
    image_url: 'https://img/photo-new.jpg', created_at: '2026-09-25T10:00:00+09:00',
    display_rotation: 0, image_width: 100, image_height: 100, image_byte_size: 100,
    risks: [], history: [], submission_count: 1, returned_count: 0,
  }
}

const noop = () => {}
const asyncNoop = async () => {}

async function renderDetail(photo: Record<string, unknown>, host: HTMLDivElement) {
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <PhotoReviewDetail
        photo={photo}
        position={0}
        total={1}
        loading={false}
        loadKind="ready"
        reviewing={false}
        notice=""
        accountNotice=""
        assetStatus={null}
        derivatives={null}
        assetsFailed={false}
        onReloadAssets={noop}
        assetProcessing={false}
        rotationSaving={false}
        onBack={noop}
        onMove={noop}
        onApprove={noop}
        onReturn={noop}
        onAdoptWithoutReward={noop}
        onProcessReviewAsset={noop}
        onSaveRotation={noop}
        onDownloadOriginal={asyncNoop}
        onPointAction={noop}
        pointActionBusy={null}
      />,
    )
  })
  return root
}

let host: HTMLDivElement

beforeEach(() => {
  policyMode = 'ok'
  installFetch()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(async () => {
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('#817 重複の表示', () => {
  it('重複なし：帯は出さず、このまま採用が主役', async () => {
    const root = await renderDetail(basePhoto(), host)
    expect(host.textContent).not.toContain('すでに採用されています')
    expect(host.textContent).toContain('このまま採用')
    expect(host.textContent).not.toContain('報酬なしで採用')
    await act(async () => { root.unmount() })
  })

  it('重複あり：帯と前の投稿の並びが出て、主役は報酬なしで採用だけ', async () => {
    const root = await renderDetail({
      ...basePhoto(),
      duplicate: {
        photoId: 'photo-old', imageUrl: 'https://img/photo-old.jpg',
        petName: 'モカ', createdAt: '2026-08-12T10:00:00+09:00', awardedPoints: 5,
      },
    }, host)
    expect(host.textContent).toContain('同じ写真がすでに採用されています')
    expect(host.textContent).toContain('今回の投稿')
    expect(host.textContent).toContain('前の投稿（採用済み）')
    expect(host.textContent).toContain('却下する')
    expect(host.textContent).toContain('報酬なしで採用')
    expect(host.textContent).not.toContain('このまま採用')
    await act(async () => { root.unmount() })
  })
})

// 109: 断る側は赤い文字だけ、採用は主（右）。
describe('109 承認が主・断る側は文字だけ', () => {
  const variants = () => {
    const buttons = [...host.querySelectorAll('button')]
    return {
      pass: buttons.find((b) => b.textContent === '見送る（理由を選択する）'),
      reject: buttons.find((b) => b.textContent === '却下する'),
      adopt: buttons.find((b) => b.textContent === 'このまま採用'),
      adoptFree: buttons.find((b) => b.textContent === '報酬なしで採用'),
    }
  }
  it('重複なし：見送るは文字だけ・このまま採用が主で右', async () => {
    const root = await renderDetail(basePhoto(), host)
    const { pass, adopt } = variants()
    expect(pass?.getAttribute('data-variant')).toBe('text')
    expect(adopt?.getAttribute('data-variant')).toBe('primary')
    expect(Boolean(pass!.compareDocumentPosition(adopt!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    await act(async () => { root.unmount() })
  })
  it('重複あり：却下するは文字だけ・報酬なしで採用が主で右', async () => {
    const root = await renderDetail({
      ...basePhoto(),
      duplicate: {
        photoId: 'photo-old', imageUrl: 'https://img/photo-old.jpg',
        petName: 'モカ', createdAt: '2026-08-12T10:00:00+09:00', awardedPoints: 5,
      },
    }, host)
    const { reject, adoptFree } = variants()
    expect(reject?.getAttribute('data-variant')).toBe('text')
    expect(adoptFree?.getAttribute('data-variant')).toBe('primary')
    expect(Boolean(reject!.compareDocumentPosition(adoptFree!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    await act(async () => { root.unmount() })
  })
})
