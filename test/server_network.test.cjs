const test = require('node:test');
const assert = require('node:assert/strict');

test('local server deadline covers slow headers and propagates timeout/cancellation through streamed bodies',async()=>{
  const {fetchWithDeadline}=await import('../server/network.js');
  const original=global.fetch;
  try {
    let signal;
    global.fetch=async(_,init)=>{signal=init.signal;return new Promise(()=>{});};
    await assert.rejects(fetchWithDeadline('https://example.test',{}, {timeoutMs:10}),{name:'TimeoutError'});
    assert.equal(signal.aborted,true);
    let cancelled=false;
    global.fetch=async(_,init)=>{signal=init.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}));};
    const response=await fetchWithDeadline('https://example.test',{}, {timeoutMs:15});
    await assert.rejects(response.text(),{name:'TimeoutError'});
    assert.equal(signal.aborted,true);
    assert.equal(cancelled,true);
    cancelled=false;
    const controller=new AbortController();
    const next=await fetchWithDeadline('https://example.test',{}, {signal:controller.signal,timeoutMs:10000});
    const reading=assert.rejects(next.text(),{name:'AbortError'});
    controller.abort();
    await reading;
    assert.equal(cancelled,true);
  } finally {global.fetch=original;}
});

test('local server streaming success and downstream cancel release upstream resources',async()=>{
  const {fetchWithDeadline}=await import('../server/network.js');
  const original=global.fetch;
  try {
    global.fetch=async()=>new Response('ok',{headers:{'Content-Type':'text/plain'}});
    const response=await fetchWithDeadline('https://example.test',{}, {timeoutMs:10000});
    assert.equal(await response.text(),'ok');
    let cancelled=false,signal;
    global.fetch=async(_,init)=>{signal=init.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}));};
    const next=await fetchWithDeadline('https://example.test');
    await next.body.cancel();
    assert.equal(cancelled,true);
    assert.equal(signal.aborted,true);
  } finally {global.fetch=original;}
});

test('Pages adapters map a transport TimeoutError to 504 and never disclose the secret',async()=>{
  const qw=await import('../functions/api/qweather.js'),proxy=await import('../functions/api/proxy.js');
  const original=global.fetch;
  try {
    global.fetch=async()=>{throw new DOMException('Upstream timeout','TimeoutError');};
    const response=await qw.onRequestGet({request:new Request('https://example.test/api/qweather?lat=22&lon=114'),env:{QWEATHER_API_KEY:'test-secret-only'}});
    assert.equal(response.status,504);
    assert.ok(!(await response.text()).includes('test-secret-only'));
    const tile=await proxy.onRequestGet({request:new Request('https://example.test/api/proxy?url='+encodeURIComponent('https://tilecache.rainviewer.com/test.png'))});
    assert.equal(tile.status,504);
  } finally {global.fetch=original;}
});
