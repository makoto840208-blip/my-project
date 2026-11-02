"""產生導航頁圖示（只要跑一次；結果 src/icon-nav-*.png 已 commit）：同樣的軍綠底、沙色線條，山換成指北箭頭＋羅盤圈"""
import os,math
from PIL import Image,ImageDraw
R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def make(n):
    k=8;S=n*k;im=Image.new('RGB',(S,S),(32,42,27));d=ImageDraw.Draw(im)
    c=S/2;sand=(207,170,112);ol=(75,90,46);w=int(S*0.045)
    d.ellipse([c-S*.36,c-S*.36,c+S*.36,c+S*.36],outline=sand,width=w)
    for a in range(0,360,90):
        r=math.radians(a);x0,y0=c+math.sin(r)*S*.36,c-math.cos(r)*S*.36;x1,y1=c+math.sin(r)*S*.30,c-math.cos(r)*S*.30
        d.line([x0,y0,x1,y1],fill=sand,width=w)
    up=[(c,c-S*.26),(c+S*.11,c+S*.14),(c,c+S*.07),(c-S*.11,c+S*.14)]
    d.polygon(up,fill=ol,outline=sand);d.line(up+[up[0]],fill=sand,width=w,joint='curve')
    return im.resize((n,n),Image.LANCZOS)
for n in(192,512):make(n).save(os.path.join(R,'src',f'icon-nav-{n}.png'))
