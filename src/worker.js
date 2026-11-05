/* Cloudflare Worker（v108）：網站檔案照舊由 assets 提供；只有 /__cwa/… 由這裡轉抓氣象署登山預報
   （瀏覽器直接抓氣象署會被跨網站限制擋）。只放行固定幾種路徑，不是開放代理；結果快取 30 分鐘。 */
const OK=/^\/(Data\/js\/info\/Info_Mountain\.js|V8\/C\/L\/Mountain\/MOD\/(Week|3hr)\/D\d{3}_(Week|3hr)_PC\.html)$/;
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/__cwa/')) {
      const p = u.pathname.slice(6);
      if (req.method !== 'GET' || !OK.test(p)) return new Response('not allowed', { status: 404 });
      const key = new Request('https://cwa-cache.invalid' + p);
      const cache = caches.default;
      let r = await cache.match(key);
      if (!r) {
        let o;
        try { o = await fetch('https://www.cwa.gov.tw' + p, { headers: { 'User-Agent': 'Mozilla/5.0 (GearPlanner weather relay)', 'Accept-Language': 'zh-TW' } }); }
        catch (e) { return new Response('upstream error', { status: 502 }); }
        if (!o.ok) return new Response('upstream ' + o.status, { status: 502 });
        r = new Response(await o.arrayBuffer(), { headers: { 'content-type': o.headers.get('content-type') || 'text/html; charset=utf-8', 'cache-control': 'public, max-age=1800' } });
        ctx.waitUntil(cache.put(key, r.clone()));
      }
      return r;
    }
    return env.ASSETS.fetch(req);
  }
};
