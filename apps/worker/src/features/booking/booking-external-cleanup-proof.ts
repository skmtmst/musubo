/** 対象の一覧が変われば後片づけも安全側で止める。顧客IDは残さない。 */
export async function cleanupRecipientProof(secret:string,accountId:string,value:string):Promise<string>{
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['cleanup-test-recipients',accountId,value])));
 return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
/** 店・担当・サービスごとの不可逆な索引。復号後にも対象を確認する。 */
export async function cleanupIndex(secret:string,accountId:string,provider:string,staffId:string):Promise<{prefix:string;index:string}>{
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sign=async(value:unknown)=>btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(value)))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const prefix=`cleanup:${await sign(['cleanup-index-key'])}:`;
 return {prefix,index:prefix+await sign(['cleanup-index',accountId,provider,staffId])};
}
