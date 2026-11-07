import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHmac,createHash} from 'node:crypto';
import vm from 'node:vm';

const source=readFileSync(new URL('./Code.gs',import.meta.url),'utf8');
const secret='test-only-secret-with-at-least-32-characters';
function bridge({quota=100,fail=false,busy=false}={}) {
  const saved=new Map([['MRX_MAIL_SECRET',secret]]),sent=[];
  let now=1800000000,released=0;
  const bytes=b=>Array.from(b,v=>v>127?v-256:v);
  const props={getProperty:k=>saved.get(k)||null,setProperty:(k,v)=>saved.set(k,v),getProperties:()=>Object.fromEntries(saved),deleteProperty:k=>saved.delete(k)};
  const context=vm.createContext({
    Date:class extends Date{static now(){return now*1000;}},
    PropertiesService:{getScriptProperties:()=>props},
    Utilities:{Charset:{UTF_8:'utf8'},DigestAlgorithm:{SHA_256:'sha256'},
      computeHmacSha256Signature:(text,key)=>bytes(createHmac('sha256',key).update(text).digest()),
      computeDigest:(_algo,text)=>bytes(createHash('sha256').update(text).digest())},
    LockService:{getScriptLock:()=>({tryLock:()=>!busy,releaseLock:()=>released++})},
    MailApp:{getRemainingDailyQuota:()=>quota,sendEmail:message=>{if(fail)throw new Error('private provider failure');sent.push(message);}},
    ContentService:{MimeType:{JSON:'application/json'},createTextOutput:text=>({text,setMimeType(){return this;}})},
  });
  vm.runInContext(source,context);
  const sign=(changes={},key=secret)=>{
    const payload=JSON.stringify({id:'a'.repeat(32),timestamp:now,recipient:'reader+tag@tuta.io',code:'001234',...changes});
    return {postData:{contents:JSON.stringify({payload,signature:createHmac('sha256',key).update('mrx-mail-v1\n'+payload).digest('hex')})}};
  };
  return {saved,sent,sign,run:e=>JSON.parse(context.doPost(e).text),advance:s=>now+=s,get released(){return released;}};
}
test('signed send, fixed template, replay deduplication and recipient cooldown',()=>{
  const b=bridge();
  assert.deepEqual(b.run(b.sign()),{ok:true,id:'a'.repeat(32)});
  assert.match(b.sent[0].body,/001234/);
  assert.equal(b.sent[0].to,'reader+tag@tuta.io');
  assert.equal(b.sent.length,1);
  assert.equal(b.run(b.sign()).ok,true);
  assert.equal(b.sent.length,1);
  assert.equal(b.run(b.sign({id:'b'.repeat(32)})).error,'cooldown');
  b.advance(61);
  assert.equal(b.run(b.sign({id:'b'.repeat(32)})).ok,true);
  assert.equal(b.sent.length,2);
  const persisted=JSON.stringify([...b.saved]);
  assert.ok(!persisted.includes('001234')&&!persisted.includes('reader+tag@tuta.io'));
  assert.equal(b.released,4);
});
test('rejects invalid signature, expired payload, multiple recipients and arbitrary content',()=>{
  const b=bridge();
  for(const e of [null,{postData:{contents:'not json'}},b.sign({},'wrong'),b.sign({timestamp:1799999000}),
    b.sign({recipient:'a@example.org,b@example.org'}),b.sign({recipient:'a@example.org\r\nBcc:b@example.org'}),
    b.sign({code:'text'}),b.sign({code:'1234567'}),b.sign({id:'bad'}),b.sign({timestamp:'1800000000'})]){
    assert.equal(b.run(e).ok,false);
  }
  const modified=b.sign();
  modified.postData.contents=modified.postData.contents.replace('001234','999999');
  assert.equal(b.run(modified).ok,false);
  assert.equal(b.sent.length,0);
  assert.equal(b.released,0);
});
test('quota, lock contention and uncertain delivery never acknowledge success',()=>{
  for(const options of [{quota:0},{busy:true},{fail:true}]){
    const b=bridge(options);
    assert.equal(b.run(b.sign()).ok,false);
    assert.equal(b.run(b.sign()).ok,false);
    assert.equal(b.sent.length,0);
  }
});
