# 登山負重規劃師（交接筆記）

單檔 PWA（繁體中文介面），作者：台灣面具仔日常 TWGASMASKER，分享給朋友用。

## 檔案
- `src/app.html`：**唯一的原始碼**（HTML+CSS+JS 全在一個檔，含內建裝備資料庫 JSON）。改這個。
- `src/sw.js`、`src/manifest.json`、圖示、`src/jsqr.js`（jsQR 1.4.0 壓縮版，cdnjs 沒有，所以跟網站放一起、sw 預先快取）：線上版附檔。
- `tools/build.py <版本>`：產生 `public/`（Cloudflare 網站，v105 起有 `index.html`＋`nav.html` 兩頁）和 `dist/cloudflare_上傳用_v<版本>.zip`。`tools/power.js <舊 public> <新 public>`：量導航畫面 15 秒的 CPU／繪製（舊版用 `git worktree add /tmp/base origin/main` 建）。`tools/gen_nav_icon.py`：產導航圖示。
- `public/`：建置結果，**不要手改**。`wrangler.jsonc` 指向它（Worker 名稱 `square-mode-1f4a`）。
- 線上網址：https://square-mode-1f4a.makoto840208.workers.dev

## 發布流程（使用者偏好）
- Cloudflare 已設 **Build watch paths：Include 只有 `public/*`**，所以只有 `public/` 有變才會自動建置（吃建置分鐘）。
- **預設**：改完 `python3 tools/build.py <下一版>`，把 dist 的 zip 傳給使用者，他自己拖到 Cloudflare 上傳。原始碼照樣 commit＋push，但**只 commit `src/`、`tools/`、`CLAUDE.md`，不要 commit `public/`**（push 不會觸發建置）。
- **使用者說「手機用」**：才連 `public/` 一起 commit 並 push，Cloudflare 會自動部署（約 1～2 分鐘，可用 `/version.txt` 驗證）。
- push 前用 `git diff --stat origin/main..HEAD` 確認沒有 `public/`（除非是「手機用」）。
- 目前版本：**v104 在 main（原本線上）；v108 在分支 `nav-split`（導航分家＋黑屏語音＋捷徑＋箭頭＋轉向平滑追蹤＋Android 外殼原始碼＋氣象署天氣＋3D 防當機；使用者有上傳 nav-split 的 zip 實測，但還沒說要合併 main，下山前不要自己合併）**。repo 的 `public/` 停在 v77。v69～v75 是在別的環境改的，v75 從使用者上傳的 zip 還原進 repo。

## 工作方式（使用者要求）
- **討論還沒結束不要先開工**，使用者明確說「開始／做」才動手。
- 改完先跑 `node tools/test.js --build`，全過才交 zip。

## 分家（v105，分支 nav-split）
- 同一份 `src/app.html` build 出兩頁：`index.html`（規劃，`PAGE='plan'`）、`nav.html`（導航，`PAGE='nav'`，build.py 把字串換掉）。各有 manifest（`manifest.json` id `./`、`manifest-nav.json` id `./nav.html`）和圖示（導航圖示 `icon-nav-*.png`），所以手機可以加成兩個 App。sw.js 預先快取兩頁，fetch 失敗時 `ignoreSearch:true`（`nav.html?go=draw` 離線也開得起來）。
- 規劃頁：`NAVSEP`（線上＝true；`file://` 與 `?gptest` 維持同頁導航＝舊測試照跑；`?gptest&split` 才走分家流程）時，`#mapBig`／`#bDraw`／`#editOpen` 改成 `goNav('' | 'draw' | 'edit')` → `nav.html?go=…`（先 `savePlan`）。導航頁：`html.navpage` 用 CSS 藏起 header／main.wrap／#reditMode／#print；開機前先把 `#rmap` 搬進 `#navMode .navmap`（地圖才有尺寸），`navBoot()` 建地圖後 `navOpen()` 或依 `?go=` 進畫路線／編輯器；關閉導航（`navClose` 尾端）→ `goPlan()` 回規劃頁。`?gptest` 會帶到另一頁。
- 共用資料：兩頁同網址，共用 localStorage／IndexedDB。`PSIG`＝上次讀／存的規劃原始字串；頁面切回前景（visibilitychange／pageshow）時若 `planSig()` 變了且沒有未存修改（`dirty`）就 `location.reload()`。導航頁不自動連網查地名（`rerenderAll` 的 `scheduleGeo` 在 `PAGE==='nav'` 跳過），山上省一次連線。
- 省電實測（tools/power.js，直式手機、同路線）：導航 15 秒腳本約 5 ms、黑屏 0 次地圖繪製，v104 與 nav.html 幾乎一樣（沒有更省、也沒有變差）；nav.html 的 JS 記憶體多約 3～5 MB（規劃介面仍在背景 DOM 渲染一次，沒有省略以免漏掉導航要用的計算）。之後要再省可考慮導航頁略過規劃 UI 的 render。

## 黑屏語音播報（v105）
- `navBoard()` 每次存 `NB.say` 快照；`bkText(kind)` 產文字、`bkSpeak(kind)` 用 `speechSynthesis`（zh-TW）念。**單點**（等 420 ms 沒第二下）念「休息點（`S.restKm`）；沒設休息點就念今日終點（下一個換天營地／終點）」的還有幾 km、爬升、約幾小時、預計幾點到、天黑前到不到得了、偏離；離路線太遠時念休息點的直線距離方位；**不念一般節點**（使用者：下一個節點就是休息點）；**長按 650 ms** 念方位與推算位置（路線第幾 km、海拔、面向、路線在你哪邊、山頭交會定位）；**連點兩下仍是回到地圖**（沒改，使用者原本說「按兩下念位置」，但黑屏連點兩下離開是既有設計，用長按取代）。沒有語音引擎就震動。黑屏有「語音：開／關」按鈕（`BK.voice`、`gearPlanner.bkVoice`）。音量鍵觸發還沒做，要等包成 Android App；使用者定的對應：**＋鍵按一下＝單點、＋鍵長按＝長按（方位與位置）**，－鍵先空著（使用者說手錶看得到，不需要）；＋－同按 3 秒＝SOS。

## v106 追加
- **導航捷徑**：`manifest.json` 的 `shortcuts`（長按首頁 App 圖示出現「導航」→ `./nav.html`，可拖到桌面變獨立圖示）。原因：nav.html 在首頁 App 的 scope 內，Chrome 不會再裝第二個 App（使用者實測「安裝會變成用原本的開」）。WebAPK 更新捷徑可能要等一陣子，等不及就刪掉首頁 App 重裝（資料存瀏覽器，不會掉）。
- **黑屏箭頭**（`#bkArr`）：細長等腰、頭長、底邊中間有缺角（使用者要的）；一般 `M0,-62 L6,-36 L0,-42 L-6,-36 Z`，高亮 `M0,-64 L8,-32 L0,-39 L-8,-32 Z`。
- **轉向順暢（v106 做法被使用者驗收「還是卡」，v107 改掉）**：v106 只是少重畫（死區 3°、130 ms 節流），結果地圖更一跳一跳。使用者說手指轉都還好、只有「跟著方向轉」卡。v107：`CAM` 平滑追蹤迴圈（`camGlide(bearing,center,padding)`／`camStep`），感應器只更新目標，每格畫面（rAF）往目標靠 22%（單格最多 9°、位置 25%），`jumpTo` 一次；有遲滯（離目標 >2° 或 >1.5 px 才起步，<0.4°／0.5 px 才停），到位就停（不再重畫）；首次對準仍用 `easeTo`（`m.isEasing()` 時迴圈等著）。羅盤轉向（`HEAD.h`）和跟隨（`folApply`）都改用它；`headStop`／`folBtn` 關掉時 `camStop()`。省電模式下跟隨／轉向時 2D 解析度最多 1.5（v106 保留，3D 仍是 1）。
- **導航頁精簡**：`rerenderAll` 在 `PAGE==='nav'` 不畫 `renderPresets／renderCats／renderFood`（規劃用的清單）；`compute()` 照跑，導航板數字不變。

## Android 外殼（v107，`android/`）
- 目的：音量鍵觸發語音（網頁收不到音量鍵）。**不是 TWA／PWA**：是自己的 WebView App（`tw.twgasmasker.gearplanner`），載入線上版 `https://square-mode-1f4a.makoto840208.workers.dev/`，所以網站更新 App 會跟著更新；兩個桌面圖示：「負重規劃」（`MainActivity`→index.html）、「導航」（`NavActivity`→nav.html，同一份資料）。
- **資料不跟 Chrome 的 PWA 共用**（WebView 有自己的儲存空間）：第一次要用「同步碼」或「備份／還原」把規劃搬過來。GPX 匯出（blob 下載）WebView 目前**不支援**；要匯出請用 Chrome 版。定位、相機（掃 QR）、選檔（匯入 GPX）、tel: 撥號（SOS）都有處理。
- 音量鍵：只有網頁呼叫 `AndroidBridge.volCapture(true)`（黑屏中）才攔截，其他時候照常調音量；＋短按→`window.__vol('up','short')`（念休息點／今日終點）、＋長按 650 ms→`('up','long')`（方位與位置）、＋－同按 3 秒→`('both','sos')`（`sosOpen`）、－鍵先空著（只攔下不調音量）。`keepOn(true/false)`：導航中螢幕常亮＋沉浸式。
- 編譯：**雲端沙箱連不到 Google／Maven／Gradle（403 政策拒絕），所以不能在這裡編 APK**。改用 `.github/workflows/android-apk.yml`（GitHub Actions，JDK 17＋Gradle 8.7＋AGP 8.5.2，GitHub 的 ubuntu 機器內建 Android SDK）：Actions 頁面手動執行 `android-apk`（或推 `android/**` 自動跑），成功後 APK 在 Releases 的 `apk-latest`（公開，手機直接下載安裝）。簽章金鑰由 workflow 產生並用 `actions/cache` 快取（key `apk-keystore-v1`，**久沒編譯被快取清掉就會換金鑰，要先解除安裝再裝**；解除安裝前先用同步碼備份）。Java／workflow 在沙箱只做過語法檢查，**還沒實際編過**，第一次編失敗請看 Actions 的紀錄修。
- 網頁端：`andCall()`、`window.__vol`（app.html，`bkSpeak` 附近）；測試只驗網頁這端（假的 `AndroidBridge`）。

## v108（2026-11-05，使用者 11/09 上奇萊南華）
- **氣象署登山天氣**（使用者選「B：免註冊、經 Cloudflare 轉抓，壞了退回 Open-Meteo」；他覺得 Open-Meteo 太不準）：`src/worker.js`（Cloudflare Worker，`wrangler.jsonc` 加 `main`＋`assets.binding:"ASSETS"`）只處理 `/__cwa/…`，白名單兩種路徑：`/Data/js/info/Info_Mountain.js`（山名清單 PID/Name，**沒有座標**）、`/V8/C/L/Mountain/MOD/Week/Dxxx_Week_PC.html`（週預報表片段，7 天白天／晚上；溫度格是 `tem-C`/`tem-F` 兩個 span，純文字會黏成「1661」，`cwaNum()` 用 °F 拆回來；降雨機率只有前 3 天，後面是「-」），快取 30 分鐘。其他路徑照舊給 assets。sw.js 不碰 `/__cwa/`。
  - App：`cwaGet()` 先試 `/__cwa`，再試直接 `www.cwa.gov.tw`（大概會被 CORS 擋）；`cwaOverlay(pts)` 在 Open-Meteo 抓完後，每個天氣點找 **6 km 內、名字對得上**的氣象署山頭：座標用 OSM 山頭（`PK.list`，沒有全台就 `pkEnsure`）＋`cwaNorm()`（去掉「主山／大山／山」再接方位峰：奇萊主山南峰＝奇萊南峰）；溫度依海拔差每 100 m 0.65°C 修正。`cwaParseWeek()` 解析失敗會丟錯 → `S.wx.cwaErr`，表下寫原因、整張用 Open-Meteo。
  - `wxVal(p,d,i)`：一格天氣的合併值（氣象署有就用它的最低／最高、體感最低、降雨機率、天氣文字；**雨量 mm、陣風**氣象署沒有，仍是 Open-Meteo；氣象署 3 天後沒降雨機率，改 Open-Meteo 並標 *）。天氣表、診斷 `wxDiag`、輕裝診斷、計畫書列印、文字匯出、`aiExport` 全部改用 `wxVal`。表格每列 `data-wxsrc="cwa|om"`、地點下小字「氣象署・山名（低 N m 已修正）」。
  - **沙箱連不到 cwa.gov.tw（代理 403）**：HTML 結構只能從 WebFetch 的摘要推，**沒拿真資料驗過**；測試用模仿的表（`cwaWeekHtml()`）。第一次上線若表下寫「氣象署：…格式變了／讀不懂」就是解析要修。
  - **部署**：Worker 程式要靠 `wrangler deploy`（Cloudflare 連 git 的自動建置＝「手機用」流程，只看 main 分支）才會上去；**手動拖 zip 只會上傳網站檔案，不會有 Worker** → `/__cwa` 404 → 自動退回 Open-Meteo（不會壞）。`wrangler deploy --dry-run` 驗過設定。
- **圖層選單選了不關**：規劃地圖 `.lyrmenu` 和導航圖層橫條（`navStrip('layers')`）選底圖／3D／山名／省電後都留著（點外面、✕、或再按圖層鈕才關），保留橫向捲動位置。
- **網頁版導航「更多」**：`@media (pointer:fine)` 時 `#navStrip .nsl`、導航 `.lyrmenu` 改換行排（以前一排超出畫面、滑鼠滑不動，後面的按鈕點不到），太矮時上下捲；`hScrollMouse()` 讓滾輪／按住拖可左右捲（拖完 `HSDRAG` 擋掉誤點）。
- **3D 當機**（使用者：3D＋山名＋純黑等高線→黑畫面、跳重開；關山名比較順）：
  - `GL3D`：3D 開著時 localStorage `gearPlanner.gl3d`＝時間；切到背景（visibilitychange）或 pagehide 清掉。開機時記號還在（6 小時內）＝上次 3D 時被瀏覽器殺掉 → 先關 3D（規劃／導航都關、存檔）並提示 6 秒。
  - `webglcontextlost`：關 3D、提示；6 秒內沒 `webglcontextrestored` 就存檔 `location.reload()`。
  - 省電模式 3D 最多傾斜 60°（原 70，預設 50°）；3D 山名上限：省電 12／不省電 25（原 40／不限）；3D 移動一開始就把山名 marker 整個移除（以前只是 CSS 藏，MapLibre 仍每格重算），停下 120 ms 後放回。
  - 3D 黑等高線：省電模式下本來就換成地形陰影（v82 設計）；使用者問為什麼 3D 不能用黑等高線，**還沒決定**要不要做「3D 粗版黑等高線」。山名改用地圖自己畫（symbol layer）也還沒做（使用者還沒選）。

## 設計原則（使用者明確要求過）
- 全 App 低飽和、軍事風；圖示一律單色線條 SVG（`ic('name')`、`ICO2`），**不用彩色 emoji、不用白色**；SOS／偏航警告才用醒目紅。
- 調整地圖（轉角度、跟隨、休息點等）**不跳 toast**；刪除欄位不跳確認，改用「復原」toast。
- 分享版**不可內建使用者個人裝備**；配速模型只用每個人自己匯入的紀錄，沒紀錄用通用時間（Naismith＋背負／經驗修正），**上河時間不當預設**（使用者手動填上河倍數才用）。
- 耗電要極低：黑屏模式、繪製解析度上限 2、黑屏時停止地圖繪製。
- 返回手勢：一層層關閉；黑屏與觸控鎖定時不作用（黑屏只能連點兩下離開）；首頁連兩次才離開。

## 架構重點
- 地圖：MapLibre GL 4.7.1（cdnjs），底圖 raster；暗色用 canvas CSS filter＋`preDark()` 反向補色；「純黑等高線」底圖用自訂 `ctr://` protocol 從 AWS terrarium DEM 即時畫等高線＋計曲線數字。
- 全螢幕導航（#navMode）：地圖鋪滿全螢幕、高度圖蓋在下方，`navPad()` 把高度圖高度設成地圖 bottom padding（＋／－、定位、整條路線才會以看得到的範圍為中心；橫式特別明顯）；導航板在高度圖右側、黑屏（羅盤雷達、休息點、日落、電量）、偏航提醒、跟隨模式、量距、標記（照片存 IndexedDB）、SOS（全螢幕、長按 1.5 秒撥號、綁定聯絡人）、觸控鎖。
- 路線編輯模式（#reditMode）：地圖＋高度圖固定、路段捲動；直式上下分。
- 隊伍房間：Firebase RTDB REST `https://team-35b92-default-rtdb.asia-southeast1.firebasedatabase.app`。規則只允許寫 `rooms/{code}/{members,owner,admins,plan,banned}`，所以隊友位置／平安回報放在 `members/{pid}/loc`、`/safe`，隊員資料用 PATCH 以免覆蓋。
- 配速：`timeFit()` 個人時間模型（總時間＋平均心率，近期加權、排除異常），`hrFit()` 簡易版，`planFor()` 決定每段時數；Garmin CSV 用「時間」欄（計時器時間）。
- 方向：`devHeading()` 平放用螢幕上緣、直立（胸掛）用手機背面；台灣磁偏角 −4.5°。
- 座標：`tm2()` WGS84→TWD97＋TWD67（近似參數），`twd2wgs()`、`twd67to97()` 反解；「前往座標」面板讓人選格式（TWD97／67 數字範圍重疊，不能猜）。上河 2020 版百岳地形圖：TWD97 紅格、TWD67 黑格。
- 導航板：只有在路線上（`live`）才報到達時刻／日落警告；`paceMultiplier(P)`＝路線上實際前進那段÷同段預計時間（扣 5 分鐘以上長休息，0.6～1.8）；坡度用路線高度算前方 200 m（不用 GPS 高度）。
- A 路線（兩點之間）：`routeAlts()` 抓 BRouter alternativeidx 0～3、`altSame()` 剔重複、`gradeStats()`（最陡＝連續 100 m）、`altPick()` 上限內 100 m 坡度均方根最小；`gradeCfg()` 一般 ≤45%／探勘預設 70%、0＝無上限；段落存 `g.alts`/`g.altSel`/`g.altManual`；`disclaim('plan'|'explore')` 第一次跳說明。
- 3D：圖層選單開關，規劃 `M3D.want`、導航 `M3D.navWant`（預設關，`map3dToggle()` 第一次跳耗電提醒、可勾不再顯示 `gearPlanner.nav3dWarn`）；獨立 `dem3d` 來源；黑屏關地形；`map3dPR()` 導航 3D＋跟隨／轉向時 pixelRatio 1；`navClose` 要在清 padding 之後才 `map3dApply()`。離線下載時 3D 有開會加 `demWide()`（外推 20 km、z10–12）。
- 山頭／對山定位（獨立模組 `PK`、`pk*`）：Overpass 抓 OSM `natural=peak`（路線外推 0.18°），存 `gearPlanner.peaks`（精簡格式 [名,高,緯,經]，`PK.full`＝全台，`pkDownloadAll()` 按鈕 #pkAll）；`pkResect()` 最小平方交會、`pkOnRoute()` 一座山＋路線交點、`pkSolve()` → `NB.fix`；黑屏雷達 `.pkrot` 反向旋轉讓山名正向。分家時整塊搬到導航。
- 導航版面（v82）：左 `.navbtns`、右 `.navbtns.navbtnsR`（App 自己的按鈕，導航時藏 MapLibre 右上控制）各放「固定按鈕＋更多」；`#navStrip` 是畫面中間的大按鈕橫條（左更多／右更多／圖層三種內容），長按 550ms 固定或取消（`NPIN`，每邊最多 3，存 `gearPlanner.navPins`，預設左 close/center、右 zin/zout）。按鈕只有一份，在按鈕欄和收納區（左 `.navmenu`、右 `.npoolR`）之間搬，開關狀態才不會跑掉；黑屏、SOS 固定。`#navMode #rmap{z-index:auto}`（不然地圖裡的東西會被鎖在按鈕底下）。
- 高度圖面板：`navProfMin()`；手指拖著走、放開時超過 1/3 或甩得快才收／開，否則彈回；收起時把手列 ≥50px（從這裡往上拉才不會被 Android 回桌面手勢搶走）；`#navProf{touch-action:none}`、`#navCard{touch-action:pan-y}`。
- 3D 效能（v82）：3D 時 pixelRatio 1.5（跟隨／轉向 1）、不疊 Esri 陰影、純黑等高線暫換地形陰影、山名最多 15 且移動時藏；等高線圖塊快取 `CTR.tiles`（跟高度資料的 `CTR.cache` 分開）。
- 等高線（v83）：`CTRW` Web Worker（OffscreenCanvas）算，不卡主執行緒；`ctr://` 先查 `CTR.tiles`→Cache Storage `gp-ctr`（`${origin}/__ctr/z/x/y.png`）→worker。離線下載時若底圖是純黑等高線，`ctrRouteTiles()` 會一起預先算（路線走廊 z11–16＋周邊 z13）；`#ctrAll` 下載全台 z11–12（LOD：遠看粗、近看細）。空白圖塊不快取。
- 路線編輯器（v83，只在編輯模式）：`ED` 狀態、`edCtl()` 道格拉斯-普克抓轉折處控制點（≤50，營地／分天點／起終點必留且營地不能刪）；拖點＝移動、點線＝加點／重算、點點＝刪除；沿步道（BRouter）／直線切換＋即時坡度 `#edSlope`；`UNDO` 多步復原（最多 20）。`edReplace()` 換掉一段後重編航點／分天索引再 `rebuildFromTrk`。
- 前方不通（v83）：`blockAt()` 在路上加危險標記；有網路 `rerouteAvoid()` 用 BRouter `nogos`（80→160 m）預覽、按確定才換；沒網路改成直線手動點＋即時坡度。
- 偏離後取代（v83）：`EXC`／`excTrack()` 記偏離時實際走的路，回到路線後導航板問要不要取代（黑屏也提醒），可復原。
- 隊伍同步（v83）：`applyRoomPlan(pl,force)` 導航中路線形狀（`routeSig`）變了不自動套，存 `RM.pend`，導航板「套用／先不要」＋震動＋黑屏「有新路線，回地圖套用」；先不要記 `RM.skipTs`，離開導航時照常套。左「更多」：`sync` 檢查路線更新（`roomCheck`）、`qrshare` 路線 QR、`qrscan` 掃 QR。
- 路線 QR（v83）：`qrPack()` 軌跡精簡（水平 3 m／高度 5 m）＋整數差分、`deflate-raw` 壓縮、base64url，切成 `GPQ1|id|i/n|資料` 多張自動輪播（qrcode-generator，cdnjs）；掃描用 BarcodeDetector，沒有就用 `jsqr.js`；`qrFeed()` 收齊→`qrConfirm()` 確認才套用。導航開啟 3 秒後 `qrPreload()`。
- 規劃畫面 QR（v84）：路線卡有「路線 QR（給隊友掃）」`#bQrShare`；「掃隊友的路線 QR」`#bQrScan` 只在 `pointer:coarse`＋有 getUserMedia 時顯示。QR 是多張輪播，只能當場用鏡頭掃，**不做截圖／上傳圖片掃描**；不在現場的隊友用房間同步或檔案。
- 隊友裝備全螢幕（v84）：寬螢幕 `#params`/`#gear`/`#dash` 是 sticky（自成圖層），`.tcmp.fs` 會被標題列和儀表板蓋住；開全螢幕時 `body.tfs-on` 把它們改 static。
- 高度圖（v85）：`#profMe` 藍線＝GPS 位置（`GPS.pKm`＋`profMe()`，離路線 >1 km 不畫；高度圖 user-select:none 防 Android 長按選字跳 Google 搜尋），`#profCur` 白線＝使用者點選（`PROF.cur`），兩條分開，GPS 更新不能動 `#profCur`（以前會把選取拉回目前位置）。放大時直接拖＝平移、按住 500 ms（震動）再拖＝移動選取線。刻度：整 500 m／整 5 km（很長的路線 10 km）粗體 12px，中間每 100 m 小字只寫後三位（2600→600）、每 1 km（放很大 0.5 km）小字，太擠就只畫線。
- 清除整條（v87）：`routeClear()` 共用（不跳確認、`toastAct` 復原）；入口：導航編輯工具列、畫路線工具列（`data-draw="clear"`，清完留在畫路線模式）、路線總覽標題列（`data-rx="clear"`，清完關總覽）。原「路線編輯模式」（#reditMode）改名**路線總覽**（它沒有編輯工具，只是地圖＋高度圖＋路段排在一起）。
- 收起路線（v88）：`#routeHide`（v90 起放在「路線計畫」卡標題旁，使用者指定位置；點擊要 stopPropagation 免得觸發卡片摺疊）→ `.wrap.routeoff` 整欄 #params 藏起來，只剩裝備＋儀表板；頂端 `#routeBar` 摘要（路線名稱＋`#rSum`，點了展開），狀態存 `gearPlanner.routeOff`；展開時 resize 地圖＋renderProfile。
- 我的裝備庫（v89）：「我的裝備」卡 `#bMineMgr` → `mineOpen()` 視窗（`.gmine`），列 `DB.filter(owned)`；新增、改重量、**汰換**＝`d.retired`（留紀錄＝擁有過這型號，`dbFor()` 排除，不出現在選單／建議／一鍵配置）、恢復、**刪除**（builtin 只拿掉 owned），都有復原。使用者說：換新就直接新增新型號，不要「汰換時選取代品」。
- 打包清單（v89）：裝備欄上方 `[data-gv]` 切換「分類／打包清單」（存 `gearPlanner.gview`）；`renderPack()` 由 compute 尾端呼叫（`PACK.c`）。每列：打勾（`s.packed`）、佔背負 %（身穿的算佔身穿 %）小橫條、數量 ±、✕＝這趟不帶（`s.on=false`，下方「不帶的 N 件」可加回）；水、食物也列出；排序由重到輕／依分類；複製文字（`packText()`）＋系統分享，不綁 LINE。
- 背負組成（v91）：橫條照 CATS 分類拆（只算背包內＋外掛；飲水含水、另列食物、瓦斯），由重到輕，<3% 併「其他」；點色塊或圖例看明細（`COMP.sel`、`compDet()`）。「基礎 BASE」那格數字保留。
- 回報（v92）：單項減重、診斷每條右邊 ✎ → 寫備註／不適用（收進「已標不適用」可恢復），存 `gearPlanner.fb`（變數 `FBK`；`FB` 是 Firebase 網址常數，別撞名）。「匯出回報」複製文字（版本 `APPVER`、路線、背負、所有備註、當時裝備）。使用者流程：山上隨手記、下山一次貼給 Claude 修。`APPVER` 由 build.py 換成 v<版本>。
- 減重建議：`SHOEACC` 排除鞋墊／鞋帶／鞋套／綁腿／冰爪等配件，不拿來當換鞋建議（v92 前曾建議用鞋墊換 RAT 靴）。
- 輕裝配置（v94，取代 v93 的「輕裝日」）：裝備欄切換「分類｜打包清單｜輕裝」（`[data-gv=light]`）。第一次點輕裝建 `S.lt={off:{}}`＝整份複製目前配置，✕＝`S.lt.off[slotId]=true` 留營地（下方「留營地 N 件」加回），`S.lt.w` 輕裝背水（預設 min(背水,1.5)L），食物算一天份行動糧；`s.packedL` 輕裝打勾；「重新從目前配置複製」「不用輕裝」都有復原。`ltCalc()` 算輕裝重量（任何地方都能叫），compute 存 `C.lt`；儀表板 `#dayRow` 兩顆「全裝｜輕裝」（`COMP.mode`）切換背負組成。不綁天數（使用者：攻頂後可能回營地再全裝下山）。
- 路段時間軸（v95）：以路段為主、天數由「在這裡過夜」自動數。軌跡：`T.cuts`＝換天（高度圖實線）、`T.sc`＝同一天的路段分割（虛線）；`rebuildFromTrk` 用兩者聯集切路段、`dayAt()` 算天數，舊路段用 ai/ci 對回來（保留 lt/ts/t0/t1）；所有重編索引處（QR 精簡、編輯器、刪減、undo、房間同步陣列化）都要同時處理 `sc`。高度圖「切天／切段」模式有「換天（實線）｜分段（虛線）」（`PROF.sk`）。手動路段：`g.night`，`segRenum()` 照順序數天數，舊資料 `segMigrate()` 從 day 推回 night；「＋新增路段」預設同一天。每段 `segTimeRow()`：這段出發 `g.ts`（空白＝接上一段到達；每天第一段用啟登時間 t0）、背負 `g.lt`（'light'＝用 `ltCalc()` 的輕裝重量算時數）、在這裡過夜（軌跡＝把終點在 cuts/sc 之間搬）。`routeDays` 依序鏈出 `SEGT`（每段 st/en/h），當天結束時間＝最後一段到達。高度圖輕裝段淡綠底＋「輕裝」字。地圖上還沒畫分段點（只有換天營地標記）。
- 天氣表（v99，v108 加氣象署見上）：`wxPoints()` 每天一組＝營地（最後一天＝終點，沒座標用起點）＋緊接當天最高點（跟營地同點就不重複）；不列「全程最高點」，也不列每座山頭（預報格約 10 km，同稜線重複）。每個地點只列它那天，超出 16 天預報的寫「MM-DD 起查得到」。各點並行抓。
- 帶水（v96）：每段 `g.wL`（「這段帶水 L」，空白＝全裝用生理參數 `S.water`、輕裝用 `ltWDef()`）；`waterMax(light)` 取全裝／輕裝路段裡最多的那段，compute 的 `waterG` 和 `ltCalc().waterG` 都用它；每段時數用那段自己的水算重量。生理參數背水量只是預設值。
- 水（v103）：生理參數背水量改唯讀參考（水量 chips 藏起來）；水以路段「這段帶水」為準。`setModeWater(light,L)`：改全裝／輕裝的水＝那個配置的路段全部同步（沒路段改 `S.water`／`S.lt.w`）。入口：分類第一個水袋列下「這次裝水」、打包清單「水」那列、輕裝頁「水」那列（`[data-wf=full|light]`，防抖 400ms；打字時 renderPack 不重畫）。compute 會把 `[data-wf]` 更新成目前值。
- 列印檢查表（v103）：打包清單「列印檢查表」→ `ckPrint()`：`ckFit()` 在螢幕外量高度，依序試 A6 8.5/8/7.5pt → B6 8.5/8/7.5pt，都放不下就 B6 7.5pt 多張；動態 `@page` size、`body.ckp` 只印 `#ckPrint`。表頭：路線、日期、天數、人數、氣溫、背負、身穿；兩欄 ☐ 清單＋水食物＋輕裝區。原本 A4 的計畫書列印（`#print`）不動。
- 輕裝頁分框（v104）：分「穿在身上／背包內／外掛」三框（各有件數、重量小計）。點「穿｜內｜掛」改位置後先留原框、標「→ 背包內」（`PACK.hold[id]`＝原框），按「整理（N 件改了位置）」（在「＋ 加回留營地的」旁）或切換頁籤才搬。
- 複製給 AI（v104）：診斷報告底下「複製給 AI 建議」→ `aiExport()` 固定繁中提問＋JSON（路線／路段時間、帶水、負重、裝備含輕裝位置、天氣、診斷）。**只輸出**，App 不收回、不動資料庫（使用者決定先這樣；之後要收回得用固定格式＋建議卡片逐張採用）。
- 輕裝診斷（v102）：儀表板切「輕裝」時 `diagnose()` 改跑 `diagLight()`：輕裝負重比、必帶（頭燈、防水外套、急救、保暖層，冷天手套）留營地就紅字、導航／電源、每個輕裝路段帶水 vs 建議（0.5 L/h，熱天 0.6）、輕裝那天的雨／風。全裝、輕裝診斷頂端各有一行標示。輕裝頁最上面「＋ 加回留營地的（N 件）」，底部留營地清單預設展開。
- 輕裝頁（v96）：身穿的也列（使用者會在營地換衣服），每件用三顆分開的「穿｜內｜掛」直接選（`data-pk=ltl`，v100；以前是點一下輪流換＋重新排序，會跳走），清單只照重量排、切位置不換順序（`S.lt.loc[slotId]`，跟全裝分開，`ltLoc()`）。
- 省電模式（v98）：`PWR.save`（`gearPlanner.pwrSave`，沒設＝手機 pointer:coarse 開、電腦關），開關在圖層選單 `[data-pwr]`。開＝原本的省電做法（解析度最多 2、3D 1.5／跟隨 1、3D 不疊陰影、純黑等高線 3D 換陰影、山頭上限 2D 80／3D 40、3D 移動時藏）；關＝原生解析度、3D 照樣陰影與等高線、山頭不設上限、移動不藏。
- 山頭標籤（v98）：`pkMarkers()` 改看**目前畫面**（以前只看路線範圍，畫面外的山永遠不標），由高到低放、文字框重疊就跳過，moveend 重算。
- 高度圖滑鼠（v97）：滑鼠只移過去不動白線（`ev.buttons&1` 才跟），點一下放白線、按住左鍵拖才移動；觸控照舊滑動。以前 hover 就會拖走白線，使用者以為「左鍵點不了」。
- 高度圖點位置：點的地方不在地圖畫面裡就 easeTo 過去（`profReveal`，跟隨模式不動）。
- 3D 中鍵（電腦）：`midDrag3d()` 按住中鍵往上拖＝開 3D＋傾斜，壓回 <6° 放開＝關 3D；**左右不旋轉**（v101 使用者要求拿掉）。
- 裝備數量（v101）：窄欄（手機、網頁沒收路線時裝備欄 ≤620px）也顯示 ×數量小格（grid 多一欄 q），以前會藏起來。
- 單行函式裡**不要用 `//` 註解**（會把同一行後面的程式註解掉），用 `/* */`。

## 測試注意
- **自動測試**：`node tools/test.js --build [--only 名稱片段] [--shots 資料夾] [--tiles] [--jobs N]`。預設同時 4 個（這台雲端機只有 2 核，約 1.7 倍快，完整一輪約 6～7 分鐘，在 10 分鐘工具上限內）；失敗的會單獨重跑一次，還失敗才算（長按、動畫類在忙碌時偶爾誤判）。截圖檔名用 `p._cur`（並行時不能用全域 cur）。模擬直式 412×915、橫式 915×412 手機，另有「網頁」1600×900 無觸控（只跑標 `vp:'網頁'` 的測試）；DEM 合成、圖磚空白、BRouter／Overpass 用假資料（`fakeAlt`、`FAKE_PEAKS`）；`DBG=1` 會印頁面錯誤的堆疊。新功能一定要加測試。
- 這個雲端環境連不到 AWS（DEM）、jsdelivr、unpkg、Cloudflare API、OSM／Overpass、Wikipedia；brouter.de 用 curl 連得到（可驗真資料）；cdnjs、NLSC、OpenTopoMap、Esri、Firebase 可透過 Playwright proxy（`proxy={'server':$HTTPS_PROXY,'bypass':'<-loopback>'}`、`--use-gl=swiftshader`）。
- 網址加 `?gptest` 會暴露 `window.__gp`（MAP、S、PROF、NAV、GPS、FOL、MEAS、RED、NB，`fn('名稱')` 可取內部函式）。

## 之前提過、還沒做
- **黑屏語音播報**：v105 已做單點／長按（見上）；之後用音量鍵、加開關。
- **包成 App／上架**（使用者在考慮上架，先暫緩）：音量鍵控制導航（Android 外殼攔截音量鍵；iPhone 不行）。操作構想：短按移動、長按確定、兩鍵同按返回、連按三下喚醒防誤觸、SOS 長按 3 秒。
- **導航分家**：v105 已做（見「分家」）；之後可再把導航頁的規劃 UI render 省掉、山頭定位模組整塊搬過去（目前兩頁共用同一份程式，山頭模組沒動）。
- 騎車模式（路線規劃／偏航／時間改騎車設定）
- 走路時用 GPS 行進方向自動校正羅盤偏差
- 每天用當天背負重量算時間（使用者說先不用）
