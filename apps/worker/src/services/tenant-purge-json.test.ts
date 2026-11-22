import { expect, test } from 'vitest';
import { redactRetainedJson } from './tenant-purge-json.js';

test('redacts private keys recursively while preserving accounting terms', () => {
  const input=JSON.stringify({name:'private',terms:{amount:1234,email:'private',nested:[{phone:'private',count:2},{TOKEN:'secret',end:'2027-01-01'}]},url:'private'});
  expect(JSON.parse(redactRetainedJson(input))).toEqual({terms:{amount:1234,nested:[{count:2},{end:'2027-01-01'}]}});
});

test('rejects malformed JSON instead of silently storing it', () => {
  expect(()=>redactRetainedJson('{')).toThrow();
});
