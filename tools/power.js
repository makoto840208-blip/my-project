// 省電比較：node tools/power.js <基準 public 資料夾> <新版 public 資料夾>
// 同樣條件（直式手機、同一條路線、圖磚空白）量導航畫面 15 秒（一般＋黑屏）：腳本執行、整體工作、版面／樣式重算、DOM 節點數、JS 記憶體
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), zlib = require('zlib');
const [BASE, NEW] = process.argv.slice(2).map(x => path.resolve(x)); const FIX = path.join(__dirname, 'fixtures');
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const png = () => { const raw = Buffer.from([0, 0, 0, 0, 0]); const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); }; const ih = Buffer.alloc(13); ih.writeUInt32BE(1, 0); ih.writeUInt32BE(1, 4); ih[8] = 8; ih[9] = 6; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]); };
const BLANK = png();
async function page(b, dir, ctx0) {
  const ctx = ctx0 || await b.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.5, hasTouch: true, isMobile: true, geolocation: { latitude: 24.0705, longitude: 121.2950 }, permissions: ['geolocation'] });
  const p = await ctx.newPage(); p._err = [];
  p.on('pageerror', e => p._err.push(e.message));
  await p.route('https://app.test/**', r => { let u = new URL(r.request().url()).pathname; if (u === '/') u = '/index.html'; const f = path.join(dir, u); if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' }); const ty = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' }[path.extname(u)] || 'application/octet-stream'; r.fulfill({ body: fs.readFileSync(f), contentType: ty }); });
  await p.route(/elevation-tiles-prod|amazonaws\.com|wmts\.nlsc\.gov\.tw|tile\.opentopomap\.org|tile\.openstreetmap\.org|arcgisonline\.com/, r => r.fulfill({ body: BLANK, contentType: 'image/png' }));
  await p.route(/brouter\.de|firebasedatabase\.app|googleapis\.com|overpass/, r => r.abort());
  return { ctx, p };
}
const ready = p => p.waitForFunction(() => document.getElementById('state') && document.getElementById('state').textContent === '已載入', null, { timeout: 30000 });
async function measure(p, secs) {
  const c = await p.context().newCDPSession(p); await c.send('Performance.enable');
  const get = async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const a = await get(); await p.waitForTimeout(secs * 1000); const z = await get();
  const frames = await p.evaluate(() => window.__frames || 0);
  const d = k => +(z[k] - a[k]).toFixed(3);
  return { script_s: d('ScriptDuration'), task_s: d('TaskDuration'), layout_s: d('LayoutDuration'), style_s: d('RecalcStyleDuration'), layouts: d('LayoutCount'), styles: d('RecalcStyleCount'), nodes: z.Nodes, heapMB: +(z.JSHeapUsedSize / 1048576).toFixed(1) };
}
const hook = p => p.evaluate(() => { window.__frames = 0; const m = window.__gp.MAP.m; m.on('render', () => { window.__frames++; }); });
async function run(label, dir, mode, b) {
  const { ctx, p } = await page(b, dir);
  await p.goto('https://app.test/?gptest'); await ready(p); await p.evaluate(() => localStorage.setItem('gearPlanner.disc', '1'));
  await p.setInputFiles('#gpxFile', path.join(FIX, 'test.gpx')); await p.waitForFunction(() => window.__gp && window.__gp.MAP.P && window.__gp.MAP.P.length > 100 && window.__gp.MAP.loaded, null, { timeout: 30000 });
  await p.evaluate(() => window.__gp.fn('savePlan')());
  if (mode === 'old') { await p.evaluate(() => document.querySelector('#mapBig').click()); }
  else { await p.goto('https://app.test/nav.html?gptest'); }
  await p.waitForFunction(() => window.__gp && window.__gp.NAV.on, null, { timeout: 30000 }); await p.waitForTimeout(3000);
  const out = { label }; await hook(p);
  out.nav = await measure(p, 15); out.nav.frames = await p.evaluate(() => window.__frames);
  await p.evaluate(() => { window.__frames = 0; document.querySelector('#navMode [data-nav="black"]').click(); }); await p.waitForTimeout(1500); await p.evaluate(() => { window.__frames = 0; });
  out.black = await measure(p, 15); out.black.frames = await p.evaluate(() => window.__frames);
  out.err = p._err.length; await ctx.close(); return out;
}
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const R = []; for (let i = 0; i < 2; i++) { R.push(await run('v104 同頁導航', BASE, 'old', b)); R.push(await run('新 nav.html', NEW, 'new', b)); }
  await b.close();
  for (const r of R) console.log(JSON.stringify(r));
})();
