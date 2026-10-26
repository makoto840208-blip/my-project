// 自動測試：node tools/test.js [--only 名稱片段] [--shots 資料夾] [--tiles] [--build]
// 先 python3 tools/build.py t（或加 --build），測的是 public/。模擬直式與橫式手機，輸出 PASS／FAIL 文字。
// --tiles：底圖用真的圖磚（較慢）；預設圖磚回空白，只測功能。DEM 用合成的 terrarium 地形。
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const R = path.resolve(__dirname, '..'), PUB = path.join(R, 'public'), FIX = path.join(__dirname, 'fixtures');
const argv = process.argv.slice(2), opt = n => { const i = argv.indexOf(n); return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const ONLY = opt('--only'), SHOTS = opt('--shots'), TILES = !!opt('--tiles');
if (opt('--build')) cp.execSync(`python3 ${path.join(R, 'tools/build.py')} t`, { stdio: 'ignore' });

// ---- 合成圖片 ----
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, px) { // px(x,y)->[r,g,b,a]
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const p = px(x, y), o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3] == null ? 255 : p[3]; } }
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
}
const BLANK = png(1, 1, () => [0, 0, 0, 0]);
const demCache = new Map();
function demTile(z, x, y) { // 用全球座標算高度，相鄰圖磚接得起來
  const k = `${z}/${x}/${y}`; if (demCache.has(k)) return demCache.get(k);
  const n = 2 ** z, b = png(256, 256, (i, j) => {
    const gx = (x + i / 256) / n, gy = (y + j / 256) / n;
    const e = 2200 + 900 * Math.sin(gx * 9000) * Math.cos(gy * 7000) + 300 * Math.sin(gx * 31000 + gy * 23000);
    const v = e + 32768; return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v % 1) * 256)];
  });
  demCache.set(k, b); return b;
}

// ---- 測試框架 ----
const results = []; let cur = null;
function ok(c, msg) { if (!c) throw new Error(msg); }
async function shot(p, name) { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${cur}_${name}.png`) }); }

async function newPage(b, vp) {
  const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2.5, hasTouch: true, isMobile: true, geolocation: { latitude: 24.0705, longitude: 121.2950, accuracy: 10 }, permissions: ['geolocation'] });
  const p = await ctx.newPage(); p._err = [];
  p.on('pageerror', e => p._err.push(e.message));
  p.on('dialog', d => { p._dlg = (p._dlg || []).concat(d.message()); d.dismiss().catch(() => {}); });
  await p.route('https://app.test/**', r => { let u = new URL(r.request().url()).pathname; if (u === '/') u = '/index.html'; const f = path.join(PUB, u); if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' }); const ty = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain' }[path.extname(u)] || 'application/octet-stream'; r.fulfill({ body: fs.readFileSync(f), contentType: ty }); });
  await p.route(/elevation-tiles-prod|amazonaws\.com/, r => { const m = r.request().url().match(/(\d+)\/(\d+)\/(\d+)\.png/); if (!m) return r.abort(); r.fulfill({ body: demTile(+m[1], +m[2], +m[3]), contentType: 'image/png' }); });
  if (!TILES) await p.route(/wmts\.nlsc\.gov\.tw|tile\.opentopomap\.org|tile\.openstreetmap\.org|arcgisonline\.com/, r => r.fulfill({ body: BLANK, contentType: 'image/png' }));
  await p.route(/brouter\.de/, r => (p._brouter ? p._brouter(r) : r.abort()));
  await p.route(/firebasedatabase\.app|googleapis\.com/, r => r.abort());
  return { ctx, p };
}
const idle = p => p.evaluate(() => new Promise(r => { const m = window.__gp && window.__gp.MAP.m; if (!m) return r(); let d = false; const f = () => { if (!d) { d = true; r(); } }; if (!m.isMoving() && m.loaded()) setTimeout(f, 120); else m.once('idle', f); setTimeout(f, 3000); }));
async function boot(p) {
  await p.goto('https://app.test/?gptest'); await p.waitForFunction(() => document.getElementById('state') && document.getElementById('state').textContent === '已載入', null, { timeout: 20000 });
  // 第一次使用的說明（如果有）先關掉
  await p.evaluate(() => { try { localStorage.setItem('gearPlanner.disc', '1'); } catch (e) {} });
}
async function loadGpx(p) {
  await p.setInputFiles('#gpxFile', path.join(FIX, 'test.gpx'));
  await p.waitForFunction(() => window.__gp && window.__gp.MAP.P && window.__gp.MAP.P.length > 100 && window.__gp.MAP.loaded, null, { timeout: 30000 });
  await idle(p);
}
async function openNav(p) { await p.evaluate(() => document.querySelector('#mapBig').click()); await p.waitForFunction(() => window.__gp.NAV.on, null, { timeout: 5000 }); await p.waitForTimeout(500); await idle(p); }
const navBtn = (p, a) => p.evaluate(a => { const b = document.querySelector(`#navMode [data-nav="${a}"]`); b.click(); }, a);
// 地圖上「沒被擋住」的範圍
const visArea = p => p.evaluate(() => {
  const m = window.__gp.MAP.m, cv = m.getCanvas().getBoundingClientRect(), np = document.querySelector('#navProf').getBoundingClientRect();
  const bs = [...document.querySelectorAll('#navMode .navbtns>button')].filter(e => !e.hidden && e.offsetParent).map(e => e.getBoundingClientRect());
  const ct = document.querySelector('.maplibregl-ctrl-top-right').getBoundingClientRect();
  const u = { l: Math.min(...bs.map(r => r.left)), t: Math.min(...bs.map(r => r.top)), r: Math.max(...bs.map(r => r.right)), b: Math.max(...bs.map(r => r.bottom)) };
  return { W: cv.width, H: cv.height, profTop: np.top - cv.top, btn: u, ctrlL: ct.left - cv.left, horiz: (u.r - u.l) > (u.b - u.t) };
});
const routeBox = p => p.evaluate(() => { const m = window.__gp.MAP.m, P = window.__gp.MAP.P; let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const q of P) { const s = m.project([q[1], q[0]]); a = Math.min(a, s.x); b = Math.min(b, s.y); c = Math.max(c, s.x); d = Math.max(d, s.y); } return { l: a, t: b, r: c, b: d }; });

const VPS = [{ n: '直式', w: 412, h: 915 }, { n: '橫式', w: 915, h: 412 }];
const TESTS = [];
const T = (name, fn, o = {}) => TESTS.push({ name, fn, o });

// ======== 測試項目 ========
T('載入沒有錯誤', async p => { ok(p._err.length === 0, '頁面錯誤：' + p._err.join(' | ')); });
T('匯入 GPX 後有高度圖與路線', async p => {
  await loadGpx(p);
  const r = await p.evaluate(() => ({ prof: !!document.querySelector('#profSvg'), wrap: !document.querySelector('#profWrap').hidden, btns: document.querySelectorAll('#profRead .pbtns button').length, feats: (window.__gp.MAP.m.getSource('route')._data.features || []).length }));
  ok(r.prof && r.wrap, '高度圖沒出現'); ok(r.btns >= 7, '高度圖控制列按鈕只有 ' + r.btns); ok(r.feats >= 1, '地圖沒有路線');
});
T('導航：控制列跟著搬進來，padding 等於高度圖高度', async p => {
  await loadGpx(p); await openNav(p); await shot(p, 'nav');
  const r = await p.evaluate(() => { const nm = document.getElementById('navMode'); return { map: nm.contains(document.getElementById('rmap')), prof: nm.contains(document.getElementById('prof')), read: nm.contains(document.getElementById('profRead')), btns: [...nm.querySelectorAll('#profRead .pbtns button')].filter(b => b.offsetParent).length, pad: window.__gp.MAP.m.getPadding().bottom, npb: document.getElementById('navProf').offsetHeight }; });
  ok(r.map && r.prof && r.read, `元件沒搬進導航：地圖${r.map} 高度圖${r.prof} 控制列${r.read}`); ok(r.btns >= 7, '控制列看得到的按鈕只有 ' + r.btns);
  ok(Math.abs(r.pad - r.npb) <= 2, `padding ${r.pad} ≠ 高度圖 ${r.npb}`);
});
T('導航：按 ＋ 放大，畫面中央的點不跑掉', async p => {
  await loadGpx(p); await openNav(p);
  const pt = await p.evaluate(() => { const m = window.__gp.MAP.m, np = document.querySelector('#navProf').getBoundingClientRect().top; return m.unproject([innerWidth / 2, np / 2]).toArray(); });
  for (let k = 0; k < 2; k++) { await p.click('.maplibregl-ctrl-zoom-in'); await p.waitForTimeout(700); }
  await idle(p);
  const r = await p.evaluate(ll => { const m = window.__gp.MAP.m, q = m.project(ll), np = document.querySelector('#navProf').getBoundingClientRect().top; return { dx: q.x - innerWidth / 2, dy: q.y - np / 2 }; }, pt);
  ok(Math.abs(r.dx) < 4 && Math.abs(r.dy) < 4, `放大後中央點偏了 (${r.dx.toFixed(0)}, ${r.dy.toFixed(0)}) px`);
});
T('導航：整條路線放到最大，不被按鈕／高度圖擋住、也不偏一邊', async p => {
  await loadGpx(p); await openNav(p); await navBtn(p, 'route'); await p.waitForTimeout(400); await idle(p); await shot(p, 'fit');
  const v = await visArea(p), b = await routeBox(p);
  const L = v.horiz ? 0 : v.btn.r, Tp = v.horiz ? v.btn.b : 0, Rt = v.ctrlL, Bt = v.profTop;
  ok(b.l >= L - 2 && b.t >= Tp - 2 && b.r <= Rt + 2 && b.b <= Bt + 2, `路線跑出可見範圍：路線 ${JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, x]) => [k, Math.round(x)])))}，可見 l${Math.round(L)} t${Math.round(Tp)} r${Math.round(Rt)} b${Math.round(Bt)}`);
  const fw = (b.r - b.l) / (Rt - L), fh = (b.b - b.t) / (Bt - Tp);
  ok(Math.max(fw, fh) > 0.75, `路線只用了可見範圍的 ${Math.round(Math.max(fw, fh) * 100)}%`);
  const cx = (b.l + b.r) / 2 - (L + Rt) / 2, cy = (b.t + b.b) / 2 - (Tp + Bt) / 2;
  ok(Math.abs(cx) < (Rt - L) * 0.12 && Math.abs(cy) < (Bt - Tp) * 0.12, `路線沒置中（偏 ${Math.round(cx)}, ${Math.round(cy)} px）`);
});
T('高度圖：◀ ▶、設起點／設終點、清除', async p => {
  await loadGpx(p); await openNav(p);
  const pb = k => p.click(`#navMode [data-pb="${k}"]`);
  await pb('a'); for (let k = 0; k < 30; k++) await pb('r'); await pb('b');
  let r = await p.evaluate(() => ({ t: document.querySelector('#navMode [data-prt]').textContent, sel: (window.__gp.MAP.m.getSource('sel')._data.features || []).length, cur: window.__gp.PROF.cur }));
  ok(r.cur > 0, '▶ 沒有移動游標'); ok(/km：/.test(r.t), '區段資訊沒出現：' + r.t); ok(r.sel === 1, '地圖上沒畫出選取區段');
  await pb('c'); r = await p.evaluate(() => (window.__gp.MAP.m.getSource('sel')._data.features || []).length); ok(r === 0, '清除後地圖區段還在');
});
T('高度圖：休息點設定與清除', async p => {
  await loadGpx(p); await openNav(p);
  for (let k = 0; k < 20; k++) await p.click('#navMode [data-pb="r"]');
  await p.click('#navMode [data-pb="rest"]'); await p.waitForTimeout(200);
  let r = await p.evaluate(() => ({ km: window.__gp.S.restKm, card: document.getElementById('navCard').textContent }));
  ok(r.km > 0, '休息點沒設上'); ok(/休息點/.test(r.card), '導航板沒顯示休息點');
  await p.click('#navMode [data-pb="rest"]'); r = await p.evaluate(() => window.__gp.S.restKm); ok(r == null, '再按一次沒取消休息點');
});
T('高度圖：×2／×4 放大、裁切、拖動平移、點選', async p => {
  await loadGpx(p); await openNav(p);
  await p.click('#navMode [data-pb="zoom"]'); await p.click('#navMode [data-pb="zoom"]'); await p.waitForTimeout(300);
  const st = await p.evaluate(() => ({ z: window.__gp.PROF.zoom, vS: window.__gp.PROF.vS, clip: !!document.querySelector('#profSvg #profClip'), lbl: document.querySelector('#navMode [data-pb="zoom"]').textContent }));
  ok(st.z === 4 && st.lbl === '×4' && st.clip, '放大狀態不對 ' + JSON.stringify(st));
  const sv = await p.evaluate(() => { const r = document.getElementById('profSvg').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const y = sv[1] + sv[3] / 2, cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sv[0] + sv[2] * 0.8, y }] });
  for (let k = 1; k <= 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sv[0] + sv[2] * 0.8 - k * 15, y }] }); await p.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(300);
  const v2 = await p.evaluate(() => window.__gp.PROF.vS); ok(v2 > st.vS + 0.1, `往左拖沒有平移（${st.vS.toFixed(2)} → ${v2.toFixed(2)}）`);
  await p.touchscreen.tap(sv[0] + sv[2] * 0.5, y); await p.waitForTimeout(200);
  const c = await p.evaluate(() => { const P = window.__gp.PROF.fn.P, i = window.__gp.PROF.cur; return P[i][3]; });
  ok(c >= v2 && c <= v2 + 16.9 / 4 + 0.01, `點選位置 ${c.toFixed(2)} km 不在可見範圍內`);
  await p.click('#navMode [data-pb="zoom"]'); const z = await p.evaluate(() => window.__gp.PROF.zoom); ok(z === 1, '再按沒回到 ×1');
});
T('黑屏：開啟、連點兩下離開', async p => {
  await loadGpx(p); await openNav(p); await navBtn(p, 'black'); await p.waitForTimeout(400); await shot(p, 'black');
  ok(await p.evaluate(() => !document.getElementById('navBlack').hidden), '黑屏沒打開');
  await p.dispatchEvent('#navBlack', 'dblclick'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.getElementById('navBlack').hidden), '連點兩下沒離開黑屏');
});
T('量距離：開關', async p => {
  await loadGpx(p); await openNav(p); await navBtn(p, 'menu'); await navBtn(p, 'meas'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__gp.MEAS.on), '量距沒打開');
  await navBtn(p, 'menu'); await navBtn(p, 'meas'); ok(await p.evaluate(() => !window.__gp.MEAS.on), '量距沒關掉');
});
T('觸控鎖：鎖定與長按解鎖', async p => {
  await loadGpx(p); await openNav(p); await navBtn(p, 'lock'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => !document.getElementById('navLock').hidden), '沒有鎖定');
  const b = await p.evaluate(() => { const r = document.querySelector('#navLock .lockb').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await p.mouse.move(b[0], b[1]); await p.mouse.down(); await p.waitForTimeout(1800); await p.mouse.up(); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.getElementById('navLock').hidden), '長按 1.5 秒沒解鎖');
});
T('GPS：導航板與高度圖位置線', async p => {
  await loadGpx(p); await openNav(p); await navBtn(p, 'center'); await p.waitForFunction(() => window.__gp.GPS.last, null, { timeout: 8000 }); await p.waitForTimeout(800);
  await p.context().setGeolocation({ latitude: 24.0707, longitude: 121.2952, accuracy: 8 }); await p.waitForTimeout(2300); // 真手機每秒都有新位置；模擬的只送一次，重畫後要再送
  const r = await p.evaluate(() => { const c = document.getElementById('profCur'); return { card: document.getElementById('navCard').textContent, stroke: c.getAttribute('stroke'), x: +c.getAttribute('x1'), X: window.__gp.PROF.fn.X }; });
  ok(r.card.length > 5, '導航板沒有內容'); ok(r.stroke === '#2f8cff', 'GPS 位置線沒有變藍');
});
T('關閉導航：元件搬回、padding 歸零', async p => {
  await loadGpx(p); await openNav(p); await p.click('#navMode [data-pb="zoom"]'); await navBtn(p, 'close'); await p.waitForTimeout(400);
  const r = await p.evaluate(() => { const box = document.querySelector('.mapbox'), pw = document.getElementById('profWrap'); return { map: box.contains(document.getElementById('rmap')), prof: pw.contains(document.getElementById('prof')), read: pw.contains(document.getElementById('profRead')), pad: window.__gp.MAP.m.getPadding(), nav: window.__gp.NAV.on }; });
  ok(!r.nav, '導航沒關'); ok(r.map && r.prof && r.read, `元件沒搬回：地圖${r.map} 高度圖${r.prof} 控制列${r.read}`);
  ok(!r.pad.top && !r.pad.bottom && !r.pad.left && !r.pad.right, 'padding 沒歸零 ' + JSON.stringify(r.pad));
});
T('路線編輯模式：高度圖下方有控制列，關閉後還原', async p => {
  await loadGpx(p); await p.evaluate(() => document.getElementById('reditBtn').click()); await p.waitForTimeout(500); await shot(p, 'redit');
  let r = await p.evaluate(() => { const M = document.getElementById('reditMode'), rd = document.getElementById('profRead'), pr = document.getElementById('prof'); const a = rd.getBoundingClientRect(), b = pr.getBoundingClientRect(); return { open: !M.hidden, inM: M.contains(rd), below: a.top >= b.bottom - 2, vis: a.height > 10 && a.bottom <= innerHeight + 1, btns: [...rd.querySelectorAll('.pbtns button')].filter(x => x.offsetParent).length }; });
  ok(r.open && r.inM, '路線編輯模式沒打開'); ok(r.vis && r.btns >= 7, `控制列看不到（按鈕 ${r.btns}）`); ok(r.below, '控制列不在高度圖下方');
  await p.evaluate(() => document.querySelector('#reditMode [data-rx="done"]').click()); await p.waitForTimeout(300);
  r = await p.evaluate(() => ({ closed: document.getElementById('reditMode').hidden, home: document.getElementById('profWrap').contains(document.getElementById('profRead')) }));
  ok(r.closed && r.home, '關閉後沒還原');
});
T('全程沒有頁面錯誤', async p => {
  await loadGpx(p); await openNav(p); await navBtn(p, 'follow'); await p.waitForTimeout(600); await navBtn(p, 'follow'); await navBtn(p, 'close'); await p.waitForTimeout(300);
  ok(p._err.length === 0, '頁面錯誤：' + p._err.join(' | '));
});

// ---- 執行 ----
(async () => {
  if (!fs.existsSync(path.join(PUB, 'index.html'))) { console.log('沒有 public/index.html，先跑 python3 tools/build.py t'); process.exit(2); }
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '<-loopback>' } : undefined });
  const t0 = Date.now();
  for (const vp of VPS) for (const t of TESTS) {
    if (ONLY && !t.name.includes(ONLY)) continue; if (t.o.vp && t.o.vp !== vp.n) continue;
    cur = `${vp.n}_${t.name.replace(/[^\w一-鿿]+/g, '_').slice(0, 30)}`;
    const { ctx, p } = await newPage(b, vp); let err = null;
    try { await boot(p); await t.fn(p, vp); if (p._err.length) throw new Error('頁面錯誤：' + p._err.join(' | ')); } catch (e) { err = e.message.split('\n')[0]; try { await shot(p, 'FAIL'); } catch (x) {} }
    results.push({ vp: vp.n, name: t.name, err }); console.log(`${err ? 'FAIL' : 'PASS'}  [${vp.n}] ${t.name}${err ? '\n      → ' + err : ''}`);
    await ctx.close();
  }
  await b.close();
  const f = results.filter(r => r.err).length;
  console.log(`\n${results.length - f}/${results.length} 通過（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  process.exit(f ? 1 : 0);
})();
