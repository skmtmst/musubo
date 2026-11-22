import { expect, test } from 'vitest';
import { redactRetainedJson } from './tenant-purge-json.js';

test('allows only accounting keys for the specific column', () => {
  const input=JSON.stringify({kind:'send_message',count:2,content:'private',values:{birthday:'private'},friendId:'private',message:'private',title:'private',reason:'private'});
  expect(JSON.parse(redactRetainedJson(input,'friend_bulk_runs.operation_json'))).toEqual({kind:'send_message',count:2});
  expect(JSON.parse(redactRetainedJson(input,'unknown.request_json'))).toEqual({});
  expect(JSON.parse(redactRetainedJson('{"amount":1200,"content":"private","values":{"name":"private"}}','booking_groups.request_json'))).toEqual({amount:1200});
});

test('rejects malformed JSON instead of silently storing it', () => {
  expect(()=>redactRetainedJson('{','booking_groups.request_json')).toThrow();
});


test('drops scalar array entries and validates allowed values by type', () => {
  const input=JSON.stringify(['private',{kind:'secret private',count:'private',amount:42,startsAt:'not a date',values:'private'},{kind:'send_message',count:3}]);
  expect(JSON.parse(redactRetainedJson(input,'booking_groups.request_json'))).toEqual([{amount:42},{kind:'send_message',count:3}]);
  expect(JSON.parse(redactRetainedJson('["private",{"id":"step","type":"send_message","content":"private"}]','common_action_versions.action_config'))).toEqual([{id:'step',type:'send_message'}]);
});
