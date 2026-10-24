const C='planner-v1';
const KEEP=[C,'gp-tiles','gp-lib'];
const SHELL=['./','./index.html','./manifest.json','./icon-192.png','./icon-512.png'];
const TILE=/(wmts\.nlsc\.gov\.tw|tile\.opentopomap\.org|tile\.openstreetmap\.org|arcgisonline\.com|elevation-tiles-prod)/;
const LIB=/cdnjs\.cloudflare\.com\/ajax\/libs\/(leaflet|qrcode|maplibre-gl)/;
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>!KEEP.includes(x)).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET')return;
  if(u.origin!==location.origin){
    // 離線地圖圖磚：先用下載好的，沒有再上網
    if(TILE.test(u.host)){e.respondWith(caches.open('gp-tiles').then(c=>c.match(e.request.url)).then(r=>r||fetch(e.request)));return;}
    // 地圖程式庫：存一份，離線也能開地圖
    if(LIB.test(e.request.url)){e.respondWith(caches.open('gp-lib').then(c=>c.match(e.request.url).then(r=>r||fetch(e.request).then(res=>{c.put(e.request.url,res.clone());return res;}))));return;}
    return; // 天氣、定位、同步直接走網路
  }
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r;})
    .catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
});
