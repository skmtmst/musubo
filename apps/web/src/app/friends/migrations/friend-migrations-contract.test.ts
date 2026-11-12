import { describe, expect, it } from 'vitest'
import { parseFriendCsv } from '../../../v8/friends/migrations/friend-csv'
import { parseUidCsv } from '../../accounts/migration'

describe('管理画面 機能3 UID・CSV移行', () => {
  it('UID対応表の必須列を読み取る', () => {
    expect(parseUidCsv('old_uid,new_uid\nold-1,new-1')).toEqual([
      { oldUid: 'old-1', newUid: 'new-1', evidenceType: 'operator_csv' },
    ])
  })

  it('R113 UID対応表の引用符内改行を1件として読み、続く行もずらさない', () => {
    expect(parseUidCsv('old_uid,new_uid\r\n"old\n-1",new-1\r\nold-2,"new\n-2"\r\n')).toEqual([
      { oldUid: 'old\n-1', newUid: 'new-1', evidenceType: 'operator_csv' },
      { oldUid: 'old-2', newUid: 'new\n-2', evidenceType: 'operator_csv' },
    ])
  })

  it('R113 閉じていない引用符の対応行を誤って結び付けない', () => {
    expect(parseUidCsv('old_uid,new_uid\nold-1,new-1\n"old-2,new-2')).toEqual([
      { oldUid: 'old-1', newUid: 'new-1', evidenceType: 'operator_csv' },
    ])
  })

  it('Harnessの書き出しCSVを取り込める', () => {
    expect(parseFriendCsv('LINEユーザーID,LINE表示名,本名,システム表示名\nU1,山田,見本 141,たろう')).toEqual([
      { lineUid: 'U1', displayName: '山田', realName: '見本 141', systemDisplayName: 'たろう' },
    ])
  })

  it('引用符内のカンマと二重引用符を保ったまま取り込める', () => {
    expect(parseFriendCsv('LINEユーザーID,LINE表示名,本名,システム表示名\nU1,"山田,太郎","山田 ""T"" 太郎",たろう')).toEqual([
      { lineUid: 'U1', displayName: '山田,太郎', realName: '山田 "T" 太郎', systemDisplayName: 'たろう' },
    ])
  })

  it('R113 引用符内の改行を含む名前は1行に保つ', () => {
    expect(parseFriendCsv('LINEユーザーID,LINE表示名,本名,システム表示名\r\nU1,"山田\n太郎",たろう,タロウ\r\nU2,鈴木,見本 181,ジロウ\r\n')).toEqual([
      { lineUid: 'U1', displayName: '山田\n太郎', realName: 'たろう', systemDisplayName: 'タロウ' },
      { lineUid: 'U2', displayName: '鈴木', realName: '見本 181', systemDisplayName: 'ジロウ' },
    ])
  })

  it('R113 書き出しの数式防止 `\'` は外し、名前の `\'` は残す', () => {
    expect(parseFriendCsv('LINEユーザーID,LINE表示名\nU1,"\'=SUM(1,2)"\nU2,"\'-さくら"\nU3,\'hello\nU4,@tanaka')).toEqual([
      { lineUid: 'U1', displayName: '=SUM(1,2)', realName: null, systemDisplayName: null },
      { lineUid: 'U2', displayName: '-さくら', realName: null, systemDisplayName: null },
      { lineUid: 'U3', displayName: "'hello", realName: null, systemDisplayName: null },
      { lineUid: 'U4', displayName: '@tanaka', realName: null, systemDisplayName: null },
    ])
  })

})
