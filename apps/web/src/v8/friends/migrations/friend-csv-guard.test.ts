import { describe, expect, it } from 'vitest'
import { parseFriendCsv, splitCsvRecords } from './friend-csv'

describe('friends/migrations/friend-csv ガード', () => {
  it('引用符で囲っていないセル途中の " で後続の行が丸ごと消えない', () => {
    const csv = [
      'LINEユーザーID,LINE表示名,本名,システム表示名',
      'U1,10"画面,山田太郎,たろう',
      'U2,花子,鈴木花子,はなこ',
    ].join('\n')

    expect(parseFriendCsv(csv)).toEqual([
      { lineUid: 'U1', displayName: '10"画面', realName: '山田太郎', systemDisplayName: 'たろう' },
      { lineUid: 'U2', displayName: '花子', realName: '鈴木花子', systemDisplayName: 'はなこ' },
    ])
  })

  it('先頭が閉じていない引用符の行は従来どおり誤結合せず捨て、非文字列入力でも落ちない', () => {
    expect(splitCsvRecords('a,b\n1,2\n"broken,3')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(splitCsvRecords(null as unknown as string)).toEqual([])
  })
})
