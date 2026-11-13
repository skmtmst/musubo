import { expect, it } from 'vitest'
import { csvTemplate } from '@/components/shared/csv-template-download'
import { FRIEND_IMPORT_HEADERS, parseFriendCsv, splitCsvRecords } from '@/v8/friends/migrations/friend-csv'
import { UID_IMPORT_HEADERS } from './csv-import-columns'
import { parseUidCsv } from '@/v8/friends/migrations/use-uid-migration'
import { TAG_IMPORT_HEADERS, parseTagCsv } from '@/components/friend-fields/tag-csv-import'
it('空の見出しだけのひな形と、記入後の4入口の列対応を守る', () => {
  expect(splitCsvRecords(csvTemplate(FRIEND_IMPORT_HEADERS))).toEqual([FRIEND_IMPORT_HEADERS])
  expect(parseFriendCsv(csvTemplate(FRIEND_IMPORT_HEADERS))).toEqual([])
  expect(parseFriendCsv(csvTemplate(FRIEND_IMPORT_HEADERS) + 'U1,花子,見本 171,常連\r\n')).toEqual([{ lineUid: 'U1', displayName: '花子', realName: '見本 171', systemDisplayName: '常連' }])
  expect(parseUidCsv(csvTemplate(UID_IMPORT_HEADERS) + 'U1,U2\r\n')).toEqual([{ oldUid: 'U1', newUid: 'U2', evidenceType: 'operator_csv' }])
  expect(parseTagCsv(csvTemplate(TAG_IMPORT_HEADERS) + '常連,来店\r\n')).toEqual([{ line: 2, name: '常連', folderName: '来店' }])
})
