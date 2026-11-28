import { describe, expect, it } from 'vitest'
import { analyzeConnections, type ConnectionPage } from './connection-analysis'

describe('rich-menus/connection-analysis の不正アクションデータ・空白切替先・並び順ガード', () => {
  it('actionData が欠損・空白だけの targetPageId でも落ちず、未指定（null）の参照切れとして検知する', () => {
    const pages: ConnectionPage[] = [
      {
        id: 'p1',
        name: 'トップ',
        orderIndex: 0,
        lineRichmenuId: null,
        areas: [
          { actionType: 'richmenuswitch', actionData: null as unknown as Record<string, unknown>, label: '壊れたボタン' },
          { actionType: 'richmenuswitch', actionData: { targetPageId: '   ' }, label: '空白ボタン' },
        ],
      },
      { id: 'p2', name: '詳細', orderIndex: 1, lineRichmenuId: null, areas: [] },
    ]

    const result = analyzeConnections(pages, 'p1')
    expect(result.missingTargetEdges).toHaveLength(2)
    expect(result.missingTargetEdges.map((edge) => edge.targetPageId)).toEqual([null, null])
    expect([...result.unreachablePageIds]).toEqual(['p2'])
  })

  it('orderIndex が NaN のページがあっても既定入口は有限な最小 orderIndex のページに決まる', () => {
    const pages: ConnectionPage[] = [
      { id: 'broken', name: '順序不明', orderIndex: Number.NaN, lineRichmenuId: null, areas: [] },
      { id: 'second', name: '2番目', orderIndex: 2, lineRichmenuId: null, areas: [] },
      { id: 'first', name: '1番目', orderIndex: 1, lineRichmenuId: null, areas: [] },
    ]

    const result = analyzeConnections(pages, null)
    expect(result.entryPageId).toBe('first')
  })
})
