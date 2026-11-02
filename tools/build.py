"""建置：python3 tools/build.py <版本號>
src/app.html（開發用單檔）→ public/（Cloudflare 網站）＋ dist/cloudflare_上傳用_v<版本>.zip（手動上傳用）"""
import sys,os,shutil,zipfile,re
R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
v=sys.argv[1] if len(sys.argv)>1 else 'dev'
s=open(os.path.join(R,'src/app.html'),encoding='utf-8').read()
# 線上版：註冊 service worker、改用 manifest 與圖示檔（本機 file:// 開時維持內嵌 manifest）
i=s.index('const icon="data:image/svg+xml,"');j=s.rfind('try{',0,i);k=s.index('}catch(e){}',i)+len('}catch(e){}')
s=s[:j]+"if(location.protocol==='file:'){"+s[j:k]+"}\nelse if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js').catch(()=>{});}"+s[k:]
s=s.replace('<meta name="apple-mobile-web-app-title" content="負重規劃師">','<meta name="apple-mobile-web-app-title" content="負重規劃師">\n<link rel="manifest" href="manifest.json">\n<link rel="icon" href="icon-192.png">\n<link rel="apple-touch-icon" href="icon-192.png">',1)
s=s.replace("const APPVER='dev'",f"const APPVER='v{v}'",1)
P=os.path.join(R,'public');os.makedirs(P,exist_ok=True)
open(os.path.join(P,'index.html'),'w',encoding='utf-8').write(s)
# 導航頁（分家，v105）：同一份程式換成 PAGE='nav'，自己的 manifest／圖示（可另外加到主畫面）
n=s.replace("const PAGE='plan';","const PAGE='nav';",1)
assert n!=s
for a,b2 in [('<link rel="manifest" href="manifest.json">','<link rel="manifest" href="manifest-nav.json">'),('<link rel="icon" href="icon-192.png">','<link rel="icon" href="icon-nav-192.png">'),('<link rel="apple-touch-icon" href="icon-192.png">','<link rel="apple-touch-icon" href="icon-nav-192.png">'),('content="負重規劃師">','content="導航">'),('<title>負重規劃師</title>','<title>登山導航</title>')]:
    assert a in n,a;n=n.replace(a,b2,1)
open(os.path.join(P,'nav.html'),'w',encoding='utf-8').write(n)
FILES=['manifest.json','manifest-nav.json','icon-192.png','icon-512.png','icon-nav-192.png','icon-nav-512.png','jsqr.js']
for f in FILES:shutil.copy(os.path.join(R,'src',f),os.path.join(P,f))
sw=open(os.path.join(R,'src/sw.js'),encoding='utf-8').read();sw=re.sub(r"planner-v[\w]+'",f"planner-v{v}'",sw,count=1)
open(os.path.join(P,'sw.js'),'w',encoding='utf-8').write(sw)
open(os.path.join(P,'version.txt'),'w').write(f'v{v}\n')
D=os.path.join(R,'dist');os.makedirs(D,exist_ok=True);z=os.path.join(D,f'cloudflare_上傳用_v{v}.zip')
with zipfile.ZipFile(z,'w',zipfile.ZIP_DEFLATED) as Z:
    for f in ['sw.js','index.html','nav.html']+FILES:Z.write(os.path.join(P,f),f)
print(z)
