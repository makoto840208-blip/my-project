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
  p.on('pageerror', e => p._err.push(e.message + (process.env.DBG ? ' @ ' + (e.stack || '').split('\n').slice(1, 3).join(' ').replace(/https:\/\/app.test\/\?gptest/g, '') : '')));
  p.on('dialog', d => { p._dlg = (p._dlg || []).concat(d.message()); (p._acceptDlg ? d.accept() : d.dismiss()).catch(() => {}); });
  await p.route('https://app.test/**', r => { let u = new URL(r.request().url()).pathname; if (u === '/') u = '/index.html'; const f = path.join(PUB, u); if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' }); const ty = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain' }[path.extname(u)] || 'application/octet-stream'; r.fulfill({ body: fs.readFileSync(f), contentType: ty }); });
  await p.route(/elevation-tiles-prod|amazonaws\.com/, r => { const m = r.request().url().match(/(\d+)\/(\d+)\/(\d+)\.png/); if (!m) return r.abort(); r.fulfill({ body: demTile(+m[1], +m[2], +m[3]), contentType: 'image/png' }); });
  if (!TILES) await p.route(/wmts\.nlsc\.gov\.tw|tile\.opentopomap\.org|tile\.openstreetmap\.org|arcgisonline\.com/, r => r.fulfill({ body: BLANK, contentType: 'image/png' }));
  await p.route(/brouter\.de/, r => (p._brouter ? p._brouter(r) : r.abort()));
  await p.route(/firebasedatabase\.app|googleapis\.com/, r => r.abort());
  await p.route(/overpass/, r => (p._ovp = (p._ovp || 0) + 1, p._ovpBody = r.request().postData() || '') && r.fulfill({ body: JSON.stringify({ elements: FAKE_PEAKS.map((q, i) => ({ type: 'node', id: i + 1, lat: q[1], lon: q[2], tags: Object.assign({ natural: 'peak', name: q[0] }, q[3] ? { ele: String(q[3]) } : {}) })) }), contentType: 'application/json' }));
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
  const bs = [...document.querySelectorAll('#navMode .navbtns:not(.navbtnsR)>button')].filter(e => !e.hidden && e.offsetParent).map(e => e.getBoundingClientRect());
  const ct = document.querySelector('#navMode .navbtnsR').getBoundingClientRect();
  const u = { l: Math.min(...bs.map(r => r.left)), t: Math.min(...bs.map(r => r.top)), r: Math.max(...bs.map(r => r.right)), b: Math.max(...bs.map(r => r.bottom)) };
  return { W: cv.width, H: cv.height, profTop: np.top - cv.top, btn: u, ctrlL: ct.left - cv.left, ctrlB: ct.bottom - cv.top, ctrlRow: ct.width > ct.height * 1.5, horiz: (u.r - u.l) > (u.b - u.t) };
});
const routeBox = p => p.evaluate(() => { const m = window.__gp.MAP.m, P = window.__gp.MAP.P; let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const q of P) { const s = m.project([q[1], q[0]]); a = Math.min(a, s.x); b = Math.min(b, s.y); c = Math.max(c, s.x); d = Math.max(d, s.y); } return { l: a, t: b, r: c, b: d }; });


// 假的 BRouter：路線 1 短但有一段 60% 陡坡、路線 2 繞遠但緩、路線 3 跟 1 重複、第 4 條沒有
const RA = { lat: 24.0560, lon: 121.2470 }, RB = { lat: 24.0700, lon: 121.2700 };
function fakeAlt(k) {
  if (k === 3) return null; const n = 200, c = [];
  for (let i = 0; i <= n; i++) { const t = i / n; let la = RA.lat + (RB.lat - RA.lat) * t, lo = RA.lon + (RB.lon - RA.lon) * t, e;
    if (k === 1) { la += 0.012 * Math.sin(Math.PI * t); e = 2000 + 60 * t; } else { const L = 2.67, x = t * L; e = 2000 + (x < 1.2 ? 0 : x < 1.3 ? (x - 1.2) / 0.1 * 60 : 60); }
    c.push([+lo.toFixed(6), +la.toFixed(6), +e.toFixed(1)]); }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } }] };
}
const brouterFake = r => { const k = +((r.request().url().match(/alternativeidx=(\d)/) || [])[1] || 0), j = fakeAlt(k); return j ? r.fulfill({ body: JSON.stringify(j), contentType: 'application/json' }) : r.fulfill({ status: 400, body: 'no alt' }); };
async function planTwoPoints(p) {
  p._brouter = brouterFake; await p.click('#addSeg');
  await p.evaluate(async ([A, B]) => { const G = window.__gp, g = G.S.route.segs[G.S.route.segs.length - 1]; await G.fn('setEnd')(g, 'from', { name: '甲登山口', lat: A.lat, lon: A.lon, ele: 2000 }); await G.fn('setEnd')(g, 'to', { name: '乙營地', lat: B.lat, lon: B.lon, ele: 2060 }); }, [RA, RB]);
  await p.waitForFunction(() => { const g = window.__gp.S.route.segs.slice(-1)[0]; return g && g.alts && g.lp; }, null, { timeout: 15000 });
}


// 假的 OpenStreetMap 山頭（在測試路線附近）
const FAKE_PEAKS = [['北測峰', 24.1155, 121.2950, 3200], ['東測山', 24.0705, 121.3540, 3100], ['西南測山', 24.0450, 121.2680, 2900], ['小測山', 24.0800, 121.3100, 2400], ['無高度山', 24.0600, 121.3000, null], ['遠方山', 24.5000, 121.6000, 3500]];
const ME = { la: 24.0705, lo: 121.2950 };

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
  for (let k = 0; k < 2; k++) { await p.click('#navMode [data-nr=zin]'); await p.waitForTimeout(700); }
  await idle(p);
  const r = await p.evaluate(ll => { const m = window.__gp.MAP.m, q = m.project(ll), np = document.querySelector('#navProf').getBoundingClientRect().top; return { dx: q.x - innerWidth / 2, dy: q.y - np / 2 }; }, pt);
  ok(Math.abs(r.dx) < 4 && Math.abs(r.dy) < 4, `放大後中央點偏了 (${r.dx.toFixed(0)}, ${r.dy.toFixed(0)}) px`);
});
T('導航：整條路線放到最大，不被按鈕／高度圖擋住、也不偏一邊', async p => {
  await loadGpx(p); await openNav(p); await navBtn(p, 'route'); await p.waitForTimeout(400); await idle(p); await shot(p, 'fit');
  const v = await visArea(p), b = await routeBox(p);
  const L = v.horiz ? 0 : v.btn.r, Tp = Math.max(v.horiz ? v.btn.b : 0, v.ctrlRow ? v.ctrlB : 0), Rt = v.ctrlRow ? v.W : v.ctrlL, Bt = v.profTop;
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
T('前往座標：App 自己的面板、TWD67 換算正確', async p => {
  await loadGpx(p); await openNav(p); await navBtn(p, 'menu'); await navBtn(p, 'goto'); await p.waitForTimeout(200);
  ok(!(p._dlg && p._dlg.length), '還在用瀏覽器跳出的輸入框'); ok(await p.evaluate(() => !!document.getElementById('gcIn')), '座標面板沒出現');
  await p.click('.modal [data-f="67"]'); await p.fill('#gcIn', '244779 2596537'); await p.fill('#gcNm', '玉山附近'); await p.click('.modal [data-gc="ok"]'); await p.waitForTimeout(300);
  const r = await p.evaluate(() => window.__gp.NB.pin); ok(r && r.n === '玉山附近', '目標點沒設上');
  const d = Math.hypot((r.la - 23.47) * 110574, (r.lo - 120.957) * 111320 * Math.cos(23.47 * Math.PI / 180)); ok(d < 5, `TWD67 換算偏了 ${d.toFixed(1)} m`);
});
T('離路線很遠時不報預計到達時刻', async p => {
  await p.context().setGeolocation({ latitude: 22.62, longitude: 120.30, accuracy: 10 });
  await loadGpx(p); await openNav(p); await navBtn(p, 'center'); await p.waitForFunction(() => window.__gp.GPS.last, null, { timeout: 8000 }); await p.waitForTimeout(2300);
  const t = await p.evaluate(() => document.getElementById('navCard').textContent + '｜' + document.getElementById('navProfInfo').textContent);
  ok(/不在路線附近/.test(t), '沒有提示不在路線附近'); ok(!/→\s*\d{1,2}:\d{2}/.test(t), '人在路線外還在報到達時刻：' + t.slice(0, 120));
}, { vp: '直式' });
T('配速倍率：長休息不算進去', async p => {
  await loadGpx(p); await openNav(p);
  const r = await p.evaluate(() => { const G = window.__gp, P = G.MAP.P; G.fn('nbCum')(P); let a = 50, b = a + 5; while (b < P.length - 1 && (P[b][3] - P[a][3] < 0.45 || G.fn('nbLegH')(P, a, b) < 0.2)) b++;
    const h = G.fn('nbLegH')(P, a, b), T = h * 60 * 1.25, now = Date.now(), tr = [], n = Math.ceil(T * 3);
    for (let k = 0; k <= n; k++) { const i = Math.round(a + (b - a) * k / n); tr.push({ la: P[i][0], lo: P[i][1], al: P[i][2], t: now - (T + 8) * 60000 + k * (T * 60000 / n) }); }
    for (let k = 1; k <= 24; k++) tr.push({ la: P[b][0], lo: P[b][1], al: P[b][2], t: now - 8 * 60000 + k * 20000 }); // 停 8 分鐘
    G.GPS.trail = tr; const m = G.fn('paceMultiplier')(P); return { m, want: T / 60 / h }; });
  ok(r.m != null && Math.abs(r.m - r.want) < 0.08, `倍率 ${r.m}，應該約 ${r.want.toFixed(2)}（休息被算進去了？）`);
}, { vp: '直式' });
T('A 路線：抓多條、剔除重複、超過坡度上限不選', async p => {
  await planTwoPoints(p); await p.evaluate(() => document.querySelector('.alts').scrollIntoView({ block: 'center' })); await p.waitForTimeout(300); await shot(p, 'alts');
  const r = await p.evaluate(() => { const g = window.__gp.S.route.segs.slice(-1)[0]; return { n: g.alts.length, sel: g.altSel, st: g.alts.map(o => o.st), km: g.km, rows: document.querySelectorAll('.alts tr[data-alt]').length, over: [...document.querySelectorAll('.alts tr[data-alt]')].map(t => t.classList.contains('over')), }; });
  const ma = await p.waitForFunction(() => { const M = window.__gp.MAP; return M.loaded && M.m.getSource('alts')._data.features.length === 1; }, null, { timeout: 15000 }).then(() => true, () => false);
  ok(r.n === 2, `應該剩 2 條（重複的剔掉），結果 ${r.n} 條`); ok(r.st[0].maxUp >= 50 && r.st[0].maxUp <= 70, `路線 1 最陡上坡應該約 60%，算出 ${r.st[0].maxUp}%`);
  ok(r.st[1].maxUp < 10, `路線 2 應該很緩，算出 ${r.st[1].maxUp}%`); ok(r.sel === 1, `一般模式應該選路線 2，選了 ${r.sel + 1}`);
  ok(r.rows === 2 && r.over[0] && !r.over[1], '比較表沒有把路線 1 標成超過上限'); ok(Math.abs(r.km - r.st[1].km) < 0.05, '路段距離沒有用選到的那條');
  ok(ma, '地圖上沒有畫出另一條候選路線（虛線）');
}, { vp: '直式' });
T('A 路線：點表格換路線、探勘模式要先同意說明', async p => {
  await planTwoPoints(p);
  await p.click('.alts tr[data-alt="0"]'); await p.waitForTimeout(200);
  let r = await p.evaluate(() => { const g = window.__gp.S.route.segs.slice(-1)[0]; return { sel: g.altSel, man: g.altManual, km: g.km, k0: g.alts[0].st.km }; });
  ok(r.sel === 0 && r.man && Math.abs(r.km - r.k0) < 0.05, '點路線 1 沒換過去');
  await p.click('#gradeBar [data-gm="explore"]'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => !!document.querySelector('.modal [data-dc="ok"]')), '切探勘模式沒有先跳說明');
  await p.click('.modal [data-dc="ok"]'); await p.waitForTimeout(200);
  r = await p.evaluate(() => ({ mode: window.__gp.fn('gradeCfg')(), over: [...document.querySelectorAll('.alts tr[data-alt]')].map(t => t.classList.contains('over')), warn: !!document.querySelector('#gradeBar .xw') }));
  ok(r.mode.mode === 'explore' && r.mode.max === 70, '探勘模式上限應該預設 70%'); ok(!r.over[0], '探勘模式下 60% 不該再標超過上限'); ok(r.warn, '探勘模式沒有顯示提醒');
  await p.fill('#gradeMax', ''); await p.dispatchEvent('#gradeMax', 'change'); await p.waitForTimeout(100);
  ok(await p.evaluate(() => window.__gp.fn('gradeCfg')().max === Infinity), '探勘模式清空應該是無上限');
}, { vp: '直式' });
T('A 路線：第一次規劃要先同意說明，取消就不規劃', async p => {
  await p.evaluate(() => localStorage.removeItem('gearPlanner.disc'));
  p._brouter = brouterFake; await p.click('#addSeg');
  const pr = p.evaluate(async ([A, B]) => { const G = window.__gp, g = G.S.route.segs.slice(-1)[0]; await G.fn('setEnd')(g, 'from', { name: '甲', lat: A.lat, lon: A.lon, ele: 2000 }); await G.fn('setEnd')(g, 'to', { name: '乙', lat: B.lat, lon: B.lon, ele: 2060 }); return { alts: !!g.alts, est: g.est }; }, [RA, RB]);
  await p.waitForSelector('.modal [data-dc="x"]', { timeout: 5000 }); await p.click('.modal [data-dc="x"]');
  const r = await pr; ok(!r.alts && r.est, '取消後還是去規劃了');
}, { vp: '直式' });
T('路線卡片：坡度列不跟其他欄位疊在一起', async p => {
  const r = await p.evaluate(() => { const g = document.getElementById('gradeBar'), w = g.nextElementSibling, a = g.getBoundingClientRect(), c = w.getBoundingClientRect(), kids = [...g.children].map(e => e.getBoundingClientRect().bottom); return { h: a.height, gap: c.top - a.bottom, inside: Math.max(...kids) <= a.bottom + 1 }; });
  ok(r.h > 20 && r.inside, `坡度列高度不對（${r.h}px），內容溢出`); ok(r.gap >= 0, '坡度列跟下一排疊在一起');
});
T('3D 地形：開關、導航時自動 2D、離開導航恢復', async p => {
  await loadGpx(p); await p.evaluate(() => document.querySelector('.lyrctl>button').click()); await p.evaluate(() => document.querySelector('.lyrmenu [data-3d]').click()); await p.waitForTimeout(900); await idle(p); await p.evaluate(() => document.getElementById('rmap').scrollIntoView({ block: 'center' })); await p.waitForTimeout(1500); await shot(p, '3d');
  let r = await p.evaluate(() => { const m = window.__gp.MAP.m; return { t: !!m.getTerrain(), pitch: m.getPitch() }; });
  ok(r.t && r.pitch > 30, `3D 沒打開（地形 ${r.t}、傾斜 ${r.pitch.toFixed(0)}°）`);
  await openNav(p); await p.waitForTimeout(300);
  r = await p.evaluate(() => { const m = window.__gp.MAP.m, b = document.querySelector('.lyrmenu [data-3d]'); return { t: !!m.getTerrain(), pitch: m.getPitch(), lbl: b.textContent }; });
  ok(!r.t && r.pitch < 1, '導航的 3D 預設關，應該是 2D'); ok(/導航/.test(r.lbl), '導航時圖層選單的 3D 開關應該標明是導航用：' + r.lbl);
  await navBtn(p, 'close'); await p.waitForFunction(() => window.__gp.MAP.m.getPitch() > 30, null, { timeout: 6000 }).catch(() => {}); // 模擬環境畫 3D 很慢
  r = await p.evaluate(() => { const m = window.__gp.MAP.m; return { t: !!m.getTerrain(), pitch: Math.round(m.getPitch()) }; }); ok(r.t && r.pitch > 30, '離開導航沒恢復 3D ' + JSON.stringify(r));
  await p.evaluate(() => { document.querySelector('.lyrctl>button').click(); document.querySelector('.lyrmenu [data-3d]').click(); }); await p.waitForTimeout(800);
  r = await p.evaluate(() => { const m = window.__gp.MAP.m; return { t: !!m.getTerrain(), pitch: m.getPitch(), mp: m.getMaxPitch() }; }); ok(!r.t && r.pitch < 1 && r.mp === 0, '關掉 3D 沒還原成平面');
});
T('對山定位：交會數學（三座山、加 ±3° 雜訊）', async p => {
  const r = await p.evaluate(([pk, me]) => { const f = window.__gp.fn, brg = f('brg'), res = f('pkResect'), hav = f('hav');
    const obs = pk.slice(0, 3).map(q => ({ n: q[0], la: q[1], lo: q[2], b: brg([me.la, me.lo], [q[1], q[2]]) }));
    const a = res(obs), noisy = res(obs.map((o, i) => Object.assign({}, o, { b: o.b + [3, -3, 2][i] })));
    return { e0: hav({ lat: a.la, lon: a.lo }, { lat: me.la, lon: me.lo }) * 1000, e1: hav({ lat: noisy.la, lon: noisy.lo }, { lat: me.la, lon: me.lo }) * 1000, est: noisy.err, behind: a.behind }; }, [FAKE_PEAKS, ME]);
  ok(r.e0 < 15, `方位完全準時應該幾乎零誤差，結果 ${r.e0.toFixed(1)} m`); ok(!r.behind, '誤判山在背後');
  ok(r.e1 < r.est * 1.2, `有雜訊時實際偏 ${r.e1.toFixed(0)} m，但只報誤差 ${r.est.toFixed(0)} m（報太小會誤導）`);
}, { vp: '直式' });
T('對山定位：只對一座山＋在路線上', async p => {
  await loadGpx(p);
  const r = await p.evaluate(pk => { const G = window.__gp, P = G.MAP.P, at = 300, f = G.fn, q = pk[1]; const b = f('brg')([P[at][0], P[at][1]], [q[1], q[2]]);
    const c = f('pkOnRoute')([{ la: q[1], lo: q[2], b }], P); return { want: P[at][3], got: c.map(o => o.km) }; }, FAKE_PEAKS);
  ok(r.got.length >= 1, '路線上找不到符合的位置'); ok(r.got.some(k => Math.abs(k - r.want) < 0.3), `應該在 ${r.want.toFixed(2)} km 附近，找到 ${r.got.map(k => k.toFixed(2)).join('、')}`);
}, { vp: '直式' });
T('對山定位：選山、記下三座、算出位置、黑屏與導航板顯示', async p => {
  await loadGpx(p); await p.waitForFunction(() => window.__gp.fn('PK').list.length > 3, null, { timeout: 8000 }).catch(() => {});
  ok(await p.evaluate(() => window.__gp.fn('PK').list.length === 6), '沒有從 OpenStreetMap 抓到山頭');
  await openNav(p); await navBtn(p, 'center'); await p.waitForFunction(() => window.__gp.GPS.last, null, { timeout: 8000 });
  await navBtn(p, 'menu'); await navBtn(p, 'peakfix'); await p.waitForSelector('#pkFix', { timeout: 3000 });
  for (const q of FAKE_PEAKS.slice(0, 3)) {
    await p.evaluate(([q, me]) => { const f = window.__gp.fn; f('BK').hd = f('brg')([me.la, me.lo], [q[1], q[2]]); }, [q, ME]); await p.waitForTimeout(600);
    const sel = await p.evaluate(() => { const b = document.querySelector('#pkLs .pki.on b'); return b && b.textContent; }); ok(sel === q[0], `對準「${q[0]}」時，自動選的是「${sel}」`);
    await p.click('#pkFix [data-pk="rec"]'); await p.waitForTimeout(150);
  }
  await shot(p, 'pkfix');
  const r = await p.evaluate(me => { const x = window.__gp.NB.fix, hav = window.__gp.fn('hav'); return { x, d: x ? hav({ lat: x.la, lon: x.lo }, { lat: me.la, lon: me.lo }) * 1000 : null, txt: document.getElementById('pkRes').textContent }; }, ME);
  ok(r.x && r.x.mode === 'tri', '三座山後沒有算出交會位置'); ok(r.d < 30, `推算位置偏 ${r.d && r.d.toFixed(0)} m`); ok(/TWD97/.test(r.txt) && /TWD67/.test(r.txt) && /紅色/.test(r.txt), '結果沒有列 TWD97／TWD67');
  // 手動輸入磁北方位：應該換算成真北（−4.5°）
  await p.fill('#pkMan', '100'); await p.waitForTimeout(500); const hd = await p.evaluate(() => document.getElementById('pkHd').textContent); ok(hd === '96°' || hd === '95°', `磁北 100° 應該換成真北約 95.5°，顯示 ${hd}`);
  await p.click('#pkFix [data-pk="x"]'); await p.waitForTimeout(200);
  await p.evaluate(([q, me]) => { const f = window.__gp.fn; f('BK').hd = f('brg')([me.la, me.lo], [q[1], q[2]]); f('navBoard')(); }, [FAKE_PEAKS[1], ME]);
  ok(/正前方：東測山/.test(await p.evaluate(() => document.getElementById('navCard').textContent)), '導航板沒有顯示正前方的山');
  await navBtn(p, 'black'); await p.waitForTimeout(400); await shot(p, 'black');
  const bk = await p.evaluate(() => ({ t: document.getElementById('nbkTxt').textContent, tri: document.querySelectorAll('#bkRose path[d^="M0,-3.2"]').length }));
  ok(/推算位置/.test(bk.t), '黑屏沒有顯示推算位置'); ok(bk.tri >= 3, `黑屏雷達應該標出附近的山，只有 ${bk.tri} 個`);
});
T('導航 3D：耗電提醒＋不再顯示、跟隨時降解析度、黑屏關地形', async p => {
  await loadGpx(p); await openNav(p);
  const tog = () => p.evaluate(() => { document.querySelector('.lyrctl>button').click(); document.querySelector('.lyrmenu [data-3d]').click(); });
  await tog(); await p.waitForSelector('.modal [data-w3="ok"]', { timeout: 3000 });
  await p.check('#w3dSkip'); await p.click('.modal [data-w3="ok"]'); await p.waitForFunction(() => !!window.__gp.MAP.m.getTerrain(), null, { timeout: 5000 }).catch(() => {});
  const st = () => p.evaluate(() => { const m = window.__gp.MAP.m; return { t: !!m.getTerrain(), pr: m.getPixelRatio() }; });
  let r = await st(); ok(r.t, '導航 3D 沒打開'); ok(r.pr === 1.5, `3D 平常解析度應該是 1.5，現在 ${r.pr}`);
  await navBtn(p, 'follow'); await p.waitForTimeout(300); r = await st(); ok(r.pr === 1, `跟隨模式時應該降到 1，現在 ${r.pr}`);
  await navBtn(p, 'follow'); await p.waitForTimeout(300); r = await st(); ok(r.pr === 1.5, `關跟隨後應該回到 1.5，現在 ${r.pr}`);
  await navBtn(p, 'black'); await p.waitForTimeout(300); r = await st(); ok(!r.t, '黑屏時應該關掉 3D 地形');
  await p.dispatchEvent('#navBlack', 'dblclick'); await p.waitForTimeout(400); r = await st(); ok(r.t, '離開黑屏應該恢復 3D');
  await tog(); await p.waitForTimeout(300); r = await st(); ok(!r.t, '再按一次沒關掉');
  await tog(); await p.waitForTimeout(300); ok(!(await p.$('.modal [data-w3]')), '勾了不再顯示，還是跳提醒'); r = await st(); ok(r.t, '第二次打開失敗');
  await navBtn(p, 'close'); await p.waitForTimeout(500); r = await st(); ok(!r.t, '規劃畫面的 3D 是另一個開關（沒開），離開導航應該回 2D');
}, { vp: '橫式' });
T('離線下載：3D 開著才一起抓遠景地形', async p => {
  await loadGpx(p); p._dlg = [];
  await p.evaluate(() => document.getElementById('mapOff').click()); await p.waitForTimeout(300);
  ok(p._dlg.length === 1 && !/3D/.test(p._dlg[0]), '3D 沒開時不該抓遠景地形：' + (p._dlg[0] || '沒有確認框'));
  const n0 = +(p._dlg[0].match(/共約 (\d+) 張/) || [])[1];
  await p.evaluate(() => window.__gp.fn('map3dSet')(true)); await p.waitForTimeout(300); p._dlg = [];
  await p.evaluate(() => document.getElementById('mapOff').click()); await p.waitForTimeout(300);
  const m = p._dlg[0] || '', k = +(m.match(/遠景（(\d+) 張）/) || [])[1], n1 = +(m.match(/共約 (\d+) 張/) || [])[1];
  if (process.env.DBG) console.log(m);
  ok(/3D 地形/.test(m) && k > 10, '3D 開著時確認框沒列出遠景地形：' + m.slice(0, 120)); ok(n1 === n0 + k, `總張數不對（${n0}＋${k}≠${n1}）`);
  const w = await p.evaluate(() => { const P = window.__gp.MAP.P, L = window.__gp.fn('demWide')(P); return { n: L.length, z: [...new Set(L.map(u => +u.match(/\/(\d+)\/\d+\/\d+\.png/)[1]))].sort() }; });
  ok(w.z.join(',') === '10,11,12', '遠景地形縮放級數應該是 10～12：' + w.z);
}, { vp: '直式' });
T('下載全台山頭：之後別區路線不再上網、重開還在', async p => {
  await loadGpx(p); await p.waitForFunction(() => window.__gp.fn('PK').list.length > 0, null, { timeout: 8000 }).catch(() => {});
  p._acceptDlg = true; p._ovp = 0; await p.click('#pkAll');
  await p.waitForFunction(() => window.__gp.fn('PK').full, null, { timeout: 8000 }).catch(() => {});
  const r = await p.evaluate(() => { const K = window.__gp.fn('PK'); return { full: K.full, bb: K.bb, n: K.list.length, btn: document.getElementById('pkAll').textContent, msg: document.getElementById('mapMsg').textContent, saved: JSON.parse(localStorage.getItem('gearPlanner.peaks')) }; });
  ok(r.full && r.bb.join(',') === '21.85,119.3,25.35,122.1', '沒有標記成全台資料 ' + JSON.stringify(r.bb)); ok(/21\.85/.test(decodeURIComponent(p._ovpBody)) && /timeout:150/.test(decodeURIComponent(p._ovpBody)), '查詢範圍不是全台');
  ok(/全台山頭 ✓ 6 座/.test(r.btn), '按鈕沒顯示已下載：' + r.btn); ok(/存好了/.test(r.msg), '沒有提示下載完成');
  ok(Array.isArray(r.saved.list[0]) && r.saved.full, '沒有用精簡格式存');
  p._ovp = 0; await p.evaluate(() => window.__gp.fn('pkEnsure')([[22.5, 120.8, 0, 0], [22.6, 120.9, 0, 10]])); await p.waitForTimeout(300);
  ok(p._ovp === 0, '已經有全台資料，換到別區路線還在上網抓');
  await p.reload(); await p.waitForFunction(() => document.getElementById('state').textContent === '已載入');
  const r2 = await p.evaluate(() => { const K = window.__gp.fn('PK'); return { n: K.list.length, full: K.full, first: K.list[0] }; });
  ok(r2.n === 6 && r2.full && r2.first.n && r2.first.la, '重開 App 後全台山頭不見了');
}, { vp: '直式' });
T('導航：右邊地圖按鈕跟左邊一樣大、不跟 SOS／高度圖重疊', async p => {
  await loadGpx(p); await openNav(p); await shot(p, 'btns');
  const r = await p.evaluate(() => { const L = document.querySelector('#navMode .navbtns:not(.navbtnsR)>button').getBoundingClientRect(), Rb = [...document.querySelectorAll('#navMode .navbtnsR>button')].filter(b => b.offsetParent).map(b => b.getBoundingClientRect());
    const sos = document.querySelector('#navMode .sosb').getBoundingClientRect(), np = document.getElementById('navProf').getBoundingClientRect(), hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return { lw: Math.round(L.width), sizes: [...new Set(Rb.map(b => Math.round(b.width) + 'x' + Math.round(b.height)))], n: Rb.length, sos: Rb.some(b => hit(b, sos)), prof: Rb.some(b => hit(b, np)) }; });
  ok(r.n === 3, '右邊預設應該是 放大、縮小、更多 三顆：' + r.n); ok(r.sizes.length === 1 && r.sizes[0] === r.lw + 'x' + r.lw, `右邊按鈕 ${r.sizes.join('、')}，左邊 ${r.lw}x${r.lw}`);
  ok(!r.sos, '右邊按鈕跟 SOS 重疊'); ok(!r.prof, '右邊按鈕跟高度圖重疊');
});
T('導航：圖層在畫面中間的大按鈕橫條、不被擋、點外面收起', async p => {
  await loadGpx(p); await openNav(p); await p.click('#navMode [data-nr=more]'); await p.waitForTimeout(150); await p.click('#navStrip .nsi[data-nr=layers]'); await p.waitForTimeout(200); await shot(p, 'layers');
  const r = await p.evaluate(() => { const m = document.getElementById('navStrip'), L = document.getElementById('nsL'), q = L.getBoundingClientRect(), bs = [...L.querySelectorAll('.nsi')], tops = new Set(bs.map(b => Math.round(b.getBoundingClientRect().top))), np = document.getElementById('navProf').getBoundingClientRect(), mq = m.getBoundingClientRect();
    const vis = bs.filter(b => { const r = b.getBoundingClientRect(); return r.right > q.left + 4 && r.left < q.right - 4; }), top = vis.every(b => { const r = b.getBoundingClientRect(), x0 = Math.max(r.left, q.left) + 4, x1 = Math.min(r.right, q.right) - 4; return [[x0, r.top + 4], [x1, r.top + 4], [x0, r.bottom - 4], [x1, r.bottom - 4]].every(([x, y]) => { const el = document.elementFromPoint(x, y); return el && b.contains(el); }); });
    return { open: !m.hidden, t: document.getElementById('nsT').textContent, row: tops.size === 1, n: bs.length, h: Math.min(...bs.map(b => b.getBoundingClientRect().height)), mid: Math.abs((mq.top + mq.bottom) / 2 - np.top / 2) < 30, wide: mq.width > innerWidth * 0.85, top }; });
  ok(r.open && r.t === '地圖圖層' && r.n >= 8, '圖層橫條沒打開'); ok(r.row, '圖層選項沒排成一橫列'); ok(r.h >= 70, `圖層按鈕太扁（${r.h}px）`); ok(r.mid && r.wide, '圖層橫條不在畫面中間'); ok(r.top, '圖層選項被別的東西蓋住');
  await p.click('#navStrip .nsi[data-lb=topo]'); await p.waitForTimeout(150); ok(await p.evaluate(() => window.__gp.fn('mapBaseKey')() === 'topo' && document.getElementById('navStrip').hidden), '點底圖沒切換或沒收起');
  await p.click('#navMode [data-nr=more]'); await p.mouse.click(Math.round(p.viewportSize().width / 2), 40); await p.waitForTimeout(150); ok(await p.evaluate(() => document.getElementById('navStrip').hidden), '點外面沒有收起來');
});
T('導航：左右「更多」橫條、長按固定（最多 3 個）、重開還在', async p => {
  await loadGpx(p); await openNav(p);
  const bar = sd => p.evaluate(sd => [...document.querySelectorAll(sd === 'L' ? '#navMode .navbtns:not(.navbtnsR)>button' : '#navMode .navbtnsR>button')].filter(b => b.offsetParent).map(b => b.dataset.nav || b.dataset.nr), sd);
  ok((await bar('L')).join() === 'close,center,menu', '左邊預設應該是 關閉、定位、更多：' + (await bar('L')));
  await p.click('#navMode [data-nav=menu]'); await p.waitForTimeout(150);
  const it = await p.evaluate(() => [...document.querySelectorAll('#navStrip .nsi')].map(b => [b.dataset.nav, b.textContent.trim(), Math.round(b.getBoundingClientRect().height)]));
  ok(it.length >= 14 && it.every(x => x[1] && x[2] >= 70), '左邊橫條的按鈕不齊或太小：' + JSON.stringify(it.slice(0, 3)));
  const hold = async sel => { const b = await p.$(sel); await b.evaluate(e => e.scrollIntoView({ inline: 'center', block: 'nearest' })); await p.waitForTimeout(250); const q = await b.boundingBox(); await p.mouse.move(q.x + q.width / 2, q.y + q.height / 2); await p.mouse.down(); await p.waitForTimeout(700); await p.mouse.up(); await p.waitForTimeout(150); };
  await hold('#navStrip .nsi[data-nav=follow]'); ok((await bar('L')).join() === 'close,center,follow,menu', '長按「跟隨」沒固定到左邊：' + (await bar('L')));
  ok(await p.evaluate(() => !document.getElementById('navStrip').hidden && window.__gp.FOL.on === false), '長按不該觸發功能、橫條也不該收起');
  await hold('#navStrip .nsi[data-nav=lock]'); const h = await p.evaluate(() => document.getElementById('nsHint').textContent); ok(/最多固定 3 個/.test(h) && (await bar('L')).length === 4, '第 4 個應該擋下來並提示：' + h);
  await hold('#navStrip .nsi[data-nav=close]'); ok((await bar('L')).join() === 'center,follow,menu', '長按已固定的沒取消：' + (await bar('L')));
  await p.click('#navStrip .nsi[data-nav=dark]'); await p.waitForTimeout(200); ok(await p.evaluate(() => document.getElementById('navStrip').hidden), '點功能後橫條應該收起');
  await p.click('#navMode [data-nr=more]'); await p.waitForTimeout(150); await hold('#navStrip .nsi[data-nr=north]'); ok((await bar('R')).join() === 'zin,zout,north,more', '右邊長按沒固定：' + (await bar('R')));
  await p.click('#navStrip .nsi[data-nr=zin]'); await p.waitForTimeout(150); ok(await p.evaluate(() => !document.getElementById('navStrip').hidden), '在橫條裡按放大，橫條應該留著可以連按');
  await p.reload(); await p.waitForFunction(() => document.getElementById('state').textContent === '已載入'); await loadGpx(p); await openNav(p);
  ok((await bar('L')).join() === 'center,follow,menu' && (await bar('R')).join() === 'zin,zout,north,more', '重開後固定的按鈕不見了');
});
T('導航：高度圖跟著手指拖、拖不夠會彈回、收起時留 50px 把手列', async p => {
  await loadGpx(p); await openNav(p); const cdp = await p.context().newCDPSession(p), x = 120;
  const tp = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const drag = async (y0, y1, steps, wait) => { await tp('touchStart', y0); for (let k = 1; k <= steps; k++) { await tp('touchMove', y0 + (y1 - y0) * k / steps); await p.waitForTimeout(wait); } };
  const st = () => p.evaluate(() => { const e = document.getElementById('navProf'), m = (getComputedStyle(e).transform.match(/matrix\(.*,\s*([-\d.]+)\)$/) || [])[1]; return { min: e.classList.contains('min'), top: Math.round(e.getBoundingClientRect().top), ty: m ? Math.round(+m) : 0, pad: Math.round(window.__gp.MAP.m.getPadding().bottom), h: e.offsetHeight, nph: Math.round(e.querySelector('.nph').getBoundingClientRect().height) }; });
  let r = await st(); ok(!r.min, '一開始應該是展開的');
  await drag(r.top + 20, r.top + 50, 6, 40); let m = await st(); ok(m.ty >= 25 && m.ty <= 35, `拖的時候面板沒跟著手指（位移 ${m.ty}px）`);
  await tp('touchEnd'); await p.waitForTimeout(350); m = await st(); ok(!m.min && m.ty === 0, '只拖一點點、慢慢放開，應該彈回去');
  await drag(r.top + 20, r.top + 200, 6, 16); await tp('touchEnd'); await p.waitForTimeout(400); r = await st(); ok(r.min, '拖夠多沒收起'); ok(Math.abs(r.pad - r.h) <= 2, '收起後地圖 padding 沒跟著變'); ok(r.nph >= 50, `收起時的把手列只有 ${r.nph}px，太矮容易被系統回桌面手勢搶走`);
  await drag(r.top + 25, r.top + 5, 6, 40); m = await st(); ok(!m.min || m.ty > 0, '往上拉時面板沒跟著出來'); await tp('touchEnd'); await p.waitForTimeout(400); m = await st(); ok(m.min, '往上拉一點點應該彈回收起');
  await drag(r.top + 25, r.top - 250, 6, 16); await tp('touchEnd'); await p.waitForTimeout(400); r = await st(); ok(!r.min, '往上拉夠多沒拉開');
  await p.click('#navProf .nph'); r = await st(); ok(r.min, '點標題列應該還是可以收');
});
T('3D 效能：純黑等高線自動換掉、少一層陰影、山名減量、關掉恢復', async p => {
  await loadGpx(p); await p.evaluate(() => window.__gp.fn('mapSetBase')('ctr')); await p.waitForTimeout(300);
  const L = () => p.evaluate(() => { const m = window.__gp.MAP.m, v = id => m.getLayoutProperty(id, 'visibility') !== 'none'; return { ctr: v('b-ctr'), hs: v('s-hs'), dem: v('s-dem') || v('b-nlsc'), on: (document.querySelector('.lyrmenu [data-base].on') || {}).dataset?.base, pk: document.querySelectorAll('.mk-pk').length, pr: m.getPixelRatio() }; });
  let r = await L(); ok(r.ctr && !r.dem, '2D 純黑等高線應該只有等高線');
  await p.evaluate(() => window.__gp.fn('map3dSet')(true)); await p.waitForTimeout(800);
  r = await L(); ok(!r.ctr && r.dem && !r.hs, `3D 時應該換成地形陰影（暗色時是台灣地形圖）、不疊 Esri 陰影（ctr ${r.ctr} 底圖 ${r.dem} hs ${r.hs}）`); ok(r.on === 'ctr', '圖層選單應該還是標「純黑等高線」（只是暫時換）'); ok(r.pk <= 15, `3D 山名應該最多 15 個，現在 ${r.pk}`); ok(r.pr === 1.5, `3D 解析度應該 1.5，現在 ${r.pr}`);
  await p.evaluate(() => window.__gp.fn('map3dSet')(false)); await p.waitForTimeout(800);
  r = await L(); ok(r.ctr && !r.dem, '關掉 3D 沒換回純黑等高線'); ok(r.pr === 2, `關掉 3D 解析度應該回到 2，現在 ${r.pr}`);
}, { vp: '直式' });
T('等高線：背景執行緒計算、預先算好的直接用、下載時一起算', async p => {
  await loadGpx(p); await p.evaluate(() => window.__gp.fn('mapSetBase')('ctr')); await p.waitForTimeout(500); await idle(p); await p.waitForTimeout(1500);
  let r = await p.evaluate(() => { const W = window.__gp.fn('CTRW'), C = window.__gp.fn('CTR'); return { ok: W.ok, n: W.id, mem: C.tiles ? C.tiles.size : 0 }; });
  ok(r.ok === true && r.n > 0 && r.mem > 0, `等高線沒在背景執行緒算（worker ${r.ok}、算了 ${r.n} 張、記憶體 ${r.mem}）`);
  // 把現在畫面要的圖塊先存好，清掉記憶體後重畫，不應該再叫背景計算
  const n0 = await p.evaluate(async () => { const G = window.__gp, m = G.MAP.m, z = Math.floor(m.getZoom()), b = m.getBounds(), L = G.fn('tilesBB')([b.getSouth() - 0.02, b.getWest() - 0.02, b.getNorth() + 0.02, b.getEast() + 0.02], Math.max(9, z - 1), z + 1);
    const [d, f] = await G.fn('ctrPrecompute')(L); G.fn('CTR').tiles.clear(); return { id: G.fn('CTRW').id, d, f, n: L.length }; });
  ok(n0.d === n0.n && n0.f === 0, `預先計算失敗：${n0.d}/${n0.n}，失敗 ${n0.f}`);
  await p.evaluate(() => { const m = window.__gp.MAP.m; window.__gp.fn('mapSetBase')('topo'); m.style.sourceCaches['ctr'] && m.style.sourceCaches['ctr'].clearTiles && m.style.sourceCaches['ctr'].clearTiles(); });
  await p.waitForTimeout(300); await p.evaluate(() => window.__gp.fn('mapSetBase')('ctr')); await p.waitForTimeout(500); await idle(p); await p.waitForTimeout(800);
  r = await p.evaluate(() => ({ id: window.__gp.fn('CTRW').id, mem: window.__gp.fn('CTR').tiles.size }));
  ok(r.mem > 0, '重畫後沒有載入等高線'); ok(r.id === n0.id, `預先算好的沒被用到，又在背景重算了 ${r.id - n0.id} 張`);
  p._dlg = []; await p.evaluate(() => document.getElementById('mapOff').click()); await p.waitForTimeout(300);
  ok(/純黑等高線先算好存起來（\d+ 張/.test(p._dlg[0] || ''), '純黑等高線底圖下載離線地圖時，沒有一起算等高線：' + (p._dlg[0] || '').slice(0, 80));
  p._dlg = []; await p.evaluate(() => { document.getElementById('ctrAll').click(); }); await p.waitForTimeout(300);
  const n = +((p._dlg[0] || '').match(/共 (\d+) 張/) || [])[1]; ok(n > 300 && n < 3000, '全台等高線概覽張數不合理：' + (p._dlg[0] || '').slice(0, 80));
}, { vp: '直式' });
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
