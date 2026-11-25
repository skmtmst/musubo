// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
const reminderAccountProperties = {
  lineAccountId: { type: 'string', nullable: true },
  lineAccount: { type: 'object', nullable: true, required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string', nullable: true } } },
};
const reminderItemSchema = { type: 'object', required: ['id', 'lineAccountId', 'lineAccount'], properties: { id: { type: 'string' }, ...reminderAccountProperties } };
const reminderListSchema = { type: 'object', properties: { success: { type: 'boolean' }, data: { oneOf: [{ type: 'array', items: reminderItemSchema }, { type: 'object', properties: { items: { type: 'array', items: reminderItemSchema } } }] } } };
const reminderDetailSchema = { type: 'object', properties: { success: { type: 'boolean' }, data: reminderItemSchema } };

export const actionsRemindersPaths = {
  '/api/common-actions/{id}/archive': {
    post: {
      tags: ['Common actions'],
      summary: '未使用の共通アクションを保管する',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Archived' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Common action not found in account scope' },
        '422': { description: 'In use by consumers (binding_exists)' },
      },
    },
  },
  '/api/common-actions/{id}/unarchive': {
    post: {
      tags: ['Common actions'],
      summary: '保管した共通アクションを戻す',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Unarchived' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Common action not found in account scope' },
        '409': { description: 'Not archived' },
      },
    },
  },
  '/api/common-actions/resources': {
    get: {
      tags: ['Common actions'],
      summary: 'きっかけ別の処理schemaと選択肢を取得',
      parameters: [
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'trigger', in: 'query', schema: { type: 'string', enum: ['tag.added'] } },
      ],
      responses: { '200': { description: '13 action schemas and scoped resources' }, '422': { description: 'Unsupported trigger' } },
    },
  },
  '/api/friends/{id}/fields': {
    get: {
      tags: ['Friends'], summary: '閲覧可能な友だちの情報欄を取得',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Friend fields' }, '403': { description: 'Staff role required' }, '404': { description: 'Friend not found in account scope' } },
    },
    put: {
      tags: ['Friends'], summary: '閲覧可能な友だちの情報欄を更新',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Friend fields updated' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Friend not found in account scope' } },
    },
  },
  '/api/reminders': {
    get: {
      tags: ['Reminders'], summary: 'LINEアカウント範囲内のリマインダ一覧を取得',
      parameters: [
        { name: 'lineAccountId', in: 'query', schema: { type: 'string' } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['order', 'next', 'created', 'updated', 'name'] } },
      ],
      responses: { '200': { description: 'Visible reminders', content: { 'application/json': { schema: reminderListSchema } } }, '400': { description: 'Invalid sort or status' }, '403': { description: 'Staff role required' }, '404': { description: 'LINE account not found in account scope' } },
    },
  },
  '/api/reminders/{id}': {
    get: { tags: ['Reminders'], summary: '閲覧可能なリマインダの詳細', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Visible reminder', content: { 'application/json': { schema: reminderDetailSchema } } }, '404': { description: 'Reminder not found in account scope' } } },
  },
  '/api/reminders/{id}/registrants': {
    get: {
      tags: ['Reminders'], summary: 'リマインダの登録者を基準日順で取得',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'Visible reminder registrants',
          content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'],
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'array', items: { $ref: '#/components/schemas/ReminderRegistrant' } },
            },
          } } },
        },
        '401': { description: 'Bearer authentication required' },
        '403': { description: 'Owner, admin, or reminders staff permission required' },
        '404': { description: 'Reminder not found in account scope' },
        '500': { description: 'Failed to read reminder registrants' },
      },
    },
  },
  '/api/reminders/{id}/registrants/{enrollmentId}': {
    patch: {
      tags: ['Reminders'], summary: '登録者の基準日を変更し、旧未送信予定を取り消す',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'enrollmentId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['targetDate', 'expectedLockVersion'],
        properties: {
          targetDate: { type: 'string', format: 'date-time' },
          expectedLockVersion: { type: 'integer', minimum: 0 },
        },
      } } } },
      responses: {
        '200': {
          description: 'Registrant target date updated or an identical retry replayed',
          content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'],
            properties: {
              success: { type: 'boolean', const: true },
              data: { $ref: '#/components/schemas/ReminderRegistrantMutation' },
            },
          } } },
        },
        '400': { description: 'Invalid targetDate or expectedLockVersion' },
        '401': { description: 'Bearer authentication required' },
        '403': { description: 'Owner, admin, or reminders staff permission required' },
        '404': { description: 'Reminder or registrant not found in account scope' },
        '409': { description: 'Registrant lock version conflict' },
        '500': { description: 'Failed to update reminder registrant' },
      },
    },
  },
  '/api/reminders/{id}/audience': {
    post: {
      tags: ['Reminders'], summary: '未保存の対象条件で人数を数え直し、先頭の顔ぶれを返す',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: {
        type: 'object',
        properties: {
          condition: { type: ['object', 'null'], description: '未保存の対象条件。送らなければ保存済みのまま数える。空は絞りなし' },
        },
      } } } },
      responses: {
        '200': {
          description: 'Audience counts and sample members',
          content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'],
            properties: {
              success: { type: 'boolean', const: true },
              data: {
                type: 'object', required: ['matched', 'excluded', 'sample'],
                properties: {
                  matched: { type: 'integer', minimum: 0 },
                  excluded: { type: 'integer', minimum: 0 },
                  sample: {
                    type: 'array', maxItems: 20,
                    items: {
                      type: 'object', required: ['id', 'displayName'],
                      properties: {
                        id: { type: 'string' },
                        displayName: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          } } },
        },
        '401': { description: 'Bearer [REDACTED] required' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Reminder not found in account scope' },
        '422': { description: 'Invalid target condition' },
        '500': { description: 'Failed to count reminder audience' },
      },
    },
  },
  '/api/reminders/{id}/registrants/{enrollmentId}/cancel': {
    post: {
      tags: ['Reminders'], summary: '登録者を取り消し、未送信予定だけを止める',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'enrollmentId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['expectedLockVersion'],
        properties: { expectedLockVersion: { type: 'integer', minimum: 0 } },
      } } } },
      responses: {
        '200': {
          description: 'Registrant cancelled or an identical retry replayed',
          content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'],
            properties: {
              success: { type: 'boolean', const: true },
              data: { $ref: '#/components/schemas/ReminderRegistrantMutation' },
            },
          } } },
        },
        '400': { description: 'Invalid expectedLockVersion' },
        '401': { description: 'Bearer authentication required' },
        '403': { description: 'Owner, admin, or reminders staff permission required' },
        '404': { description: 'Reminder or registrant not found in account scope' },
        '409': { description: 'Registrant lock version conflict' },
        '500': { description: 'Failed to cancel reminder registrant' },
      },
    },
  },
  '/api/reminders/{id}/registrants/{enrollmentId}/resume': {
    post: {
      tags: ['Reminders'], summary: '取消済み登録者を再開し、未送信予定を再計算対象へ戻す',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'enrollmentId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['expectedLockVersion'],
        properties: { expectedLockVersion: { type: 'integer', minimum: 0 } },
      } } } },
      responses: {
        '200': {
          description: 'Registrant resumed or an identical retry replayed',
          content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'],
            properties: {
              success: { type: 'boolean', const: true },
              data: { $ref: '#/components/schemas/ReminderRegistrantMutation' },
            },
          } } },
        },
        '400': { description: 'Invalid expectedLockVersion' },
        '401': { description: 'Bearer authentication required' },
        '403': { description: 'Owner, admin, or reminders staff permission required' },
        '404': { description: 'Reminder or registrant not found in account scope' },
        '409': { description: 'Registrant lock version conflict' },
        '500': { description: 'Failed to resume reminder registrant' },
      },
    },
  },
  '/api/reminders/{id}/restore': {
    post: {
      tags: ['Reminders'], summary: '削除したリマインダの定義を元に戻す（戻した直後は停止のまま。登録・配信予定は戻さない）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Reminder definition restored as stopped' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Reminder not found or not deleted' } },
    },
  },
  '/api/reminders/{id}/steps/{stepId}': {
    delete: {
      tags: ['Reminders'], summary: '指定したリマインダに属する通を削除',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Reminder step deleted' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Reminder or step not found in account scope' } },
    },
  },
  '/api/reminders/{id}/test-recipient': {
    get: {
      tags: ['Reminders'], summary: '下書きのテスト送信で実際に届く送信先の状態を取得（N-070）。recipientKind が本人宛て(self)と登録済みテスト宛先(registered)を区別する（REMINDER-12）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Test recipient state: unset / unavailable / ready, with recipientKind distinguishing self vs registered test recipient' }, '403': { description: 'Staff role required' }, '404': { description: 'Draft not found' } },
    },
  },
  '/api/friends/{friendId}/reminders': {
    get: {
      tags: ['Reminders'], summary: '閲覧可能な友だちのリマインダ登録を取得',
      parameters: [{ name: 'friendId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Friend reminders' }, '403': { description: 'Staff role required' }, '404': { description: 'Friend not found in account scope' } },
    },
  },
};
