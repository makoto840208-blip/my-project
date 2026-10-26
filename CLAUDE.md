# 登山負重規劃師（交接筆記）

單檔 PWA（繁體中文介面），作者：台灣面具仔日常 TWGASMASKER，分享給朋友用。

## 檔案
- `src/app.html`：**唯一的原始碼**（HTML+CSS+JS 全在一個檔，含內建裝備資料庫 JSON）。改這個。
- `src/sw.js`、`src/manifest.json`、圖示：線上版附檔。
- `tools/build.py <版本>`：產生 `public/`（Cloudflare 網站）和 `dist/cloudflare_上傳用_v<版本>.zip`。
- `public/`：建置結果，**不要手改**。`wrangler.jsonc` 指向它（Worker 名稱 `square-mode-1f4a`）。
- 線上網址：https://square-mode-1f4a.makoto840208.workers.dev

## 發布流程（使用者偏好）
- Cloudflare 已設 **Build watch paths：Include 只有 `public/*`**，所以只有 `public/` 有變才會自動建置（吃建置分鐘）。
- **預設**：改完 `python3 tools/build.py <下一版>`，把 dist 的 zip 傳給使用者，他自己拖到 Cloudflare 上傳。原始碼照樣 commit＋push，但**只 commit `src/`、`tools/`、`CLAUDE.md`，不要 commit `public/`**（push 不會觸發建置）。
- **使用者說「手機用」**：才連 `public/` 一起 commit 並 push，Cloudflare 會自動部署（約 1～2 分鐘，可用 `/version.txt` 驗證）。
- push 前用 `git diff --stat origin/main..HEAD` 確認沒有 `public/`（除非是「手機用」）。
- 目前版本：**v81**（線上是使用者手動上傳的版本；repo 的 `public/` 停在 v77）。v69～v75 是在別的環境改的，v75 從使用者上傳的 zip 還原進 repo。

## 工作方式（使用者要求）
- **討論還沒結束不要先開工**，使用者明確說「開始／做」才動手。
- 改完先跑 `node tools/test.js --build`，全過才交 zip。

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
- 導航版面（v81）：右上地圖按鈕跟左邊一樣大（直式 52、橫式 42，橫式排成右上一橫列）；圖層選單在導航中是畫面中間的 fixed 橫列（`#navMode #rmap{z-index:auto}`、`.lyrctl{transform:none}`，不然會被鎖在 SOS／左邊按鈕底下）；高度圖面板 `navProfMin()`，往下滑收起、往上滑拉開（導航板清單可捲時不算）。`mapInsets` 對左邊按鈕和右邊按鈕都會判斷直欄或橫列。
- 單行函式裡**不要用 `//` 註解**（會把同一行後面的程式註解掉），用 `/* */`。

## 測試注意
- **自動測試**：`node tools/test.js --build [--only 名稱片段] [--shots 資料夾] [--tiles]`。模擬直式 412×915、橫式 915×412 手機；DEM 合成、圖磚空白、BRouter／Overpass 用假資料（`fakeAlt`、`FAKE_PEAKS`）；`DBG=1` 會印頁面錯誤的堆疊。新功能一定要加測試。
- 這個雲端環境連不到 AWS（DEM）、jsdelivr、unpkg、Cloudflare API、OSM／Overpass、Wikipedia；brouter.de 用 curl 連得到（可驗真資料）；cdnjs、NLSC、OpenTopoMap、Esri、Firebase 可透過 Playwright proxy（`proxy={'server':$HTTPS_PROXY,'bypass':'<-loopback>'}`、`--use-gl=swiftshader`）。
- 網址加 `?gptest` 會暴露 `window.__gp`（MAP、S、PROF、NAV、GPS、FOL、MEAS、RED、NB，`fn('名稱')` 可取內部函式）。

## 之前提過、還沒做
- **導航分家**（下一輪，使用者同意）：導航獨立成第二個頁面／圖示，同網址共用 localStorage／IndexedDB（資料即時同步、離線可用），地圖／高度圖／畫線拆成共用程式由 build 組進兩頁；導航只有地圖但可編輯。山頭定位模組整塊搬過去。現在導航是「借」首頁的 #rmap、#prof、#profRead 搬來搬去，容易漏搬（v75 的控制列消失就是這樣）。
- 騎車模式（路線規劃／偏航／時間改騎車設定）
- 走路時用 GPS 行進方向自動校正羅盤偏差
- 每天用當天背負重量算時間（使用者說先不用）
