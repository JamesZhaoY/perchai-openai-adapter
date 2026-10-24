import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const origin = 'http://127.0.0.1:18791';
const page = await fetch(origin + '/console');
const cookie = page.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
await page.body.cancel();
if (!page.ok || !cookie) throw new Error('本地控制台不可用');
const models = process.argv.slice(2);
if (!models.length) throw new Error('请指定一个或多个 Starter 模型；每个会产生一次真实调用');
const results = [];
for (const model of models) {
  const started = Date.now();
  try {
    const response = await fetch(origin + '/console/api/model-test', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type':'application/json' },
      body: JSON.stringify({ model }), signal: AbortSignal.timeout(190000),
    });
    const data = await response.json();
    results.push({ requested:model, status:response.status, ...data });
  } catch (error) { results.push({ requested:model, ok:false, error:error.message }); }
  console.log(JSON.stringify({ ...results.at(-1), wallMs:Date.now()-started }));
}
const dir=fileURLToPath(new URL('../reports/',import.meta.url));
await mkdir(dir,{recursive:true});
await writeFile(dir+'desktop-live-test.json',JSON.stringify({at:new Date().toISOString(),runtime:'direct cli protocol (perchai-cli@2.4.115 reference)',results},null,2));
if (results.some(r => !r.ok)) process.exitCode=1;
