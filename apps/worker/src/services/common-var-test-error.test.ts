import { expect, it, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { CommonVarResolutionFailedError, resolveSendCommonVars } from './interpolation-context.js';
import { commonVarTestError } from './common-var-test-error.js';

it('未解決の名前を対象アカウントから取得し、未知のキーと読取失敗でも送信を拒否する', async () => {
  const f = createTestD1();
  try {
    f.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','a','店','fixture','fixture'),('b','b','別店','fixture','fixture');
      INSERT INTO common_vars(id,line_account_id,name,var_key,type,value,status,archived_at) VALUES
      ('one','a','営業時間','hours','text','','draft','2026-01-01'),('two','b','別店の名前','hours','text','','draft',NULL)`);
    const error = new CommonVarResolutionFailedError([{varKey:'hours',reason:'missing'},{varKey:'unknown',reason:'missing'},{varKey:'hours',reason:'missing'}],{kind:'test_send',id:'fixture'});
    const result = await commonVarTestError(f.db, 'a', error);
    expect(result).toMatchObject({code:'COMMON_VAR_UNRESOLVED',data:{variables:[{key:'hours',displayName:'営業時間'},{key:'unknown',displayName:'unknown'}]}});
    const failedDb = {prepare:vi.fn(() => { throw new Error('db offline'); })} as unknown as D1Database;
    expect(await commonVarTestError(failedDb,'a',error)).toMatchObject({code:'COMMON_VAR_UNRESOLVED',data:{variables:[{key:'hours',displayName:'hours'},{key:'unknown',displayName:'unknown'}]}});
  } finally { f.raw.close(); }
});

it('送信で解決したアカウントを失敗に保持する', async () => {
  const f = createTestD1();
  try {
    f.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','a','店','fixture','fixture')");
    await expect(resolveSendCommonVars(f.db,'a','{{var.absent}}',{kind:'test_send',id:'fixture'}))
      .rejects.toMatchObject({name:'CommonVarResolutionFailedError',lineAccountId:'a',failures:[{varKey:'absent',reason:'missing'}]});
  } finally { f.raw.close(); }
});
