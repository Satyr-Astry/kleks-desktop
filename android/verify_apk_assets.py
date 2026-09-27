"""验收：APK 里的网页产物是否与（已被 Electron 版验证过的）dist 逐字节一致。"""
import hashlib
import os
import zipfile

APK = r'E:\dev\kleks-android\Kleks-1.0.0-android.apk'
DIST = r'E:\dev\Kleks桌面版\resources\app\dist'


def sha(b):
    return hashlib.sha256(b).hexdigest()


z = zipfile.ZipFile(APK)
inapk = {}
for n in z.namelist():
    if n.startswith('assets/web/'):
        inapk[n[len('assets/web/'):]] = sha(z.read(n))

same = diff = 0
problems = []
for rel, h in inapk.items():
    p = os.path.join(DIST, rel.replace('/', os.sep))
    if not os.path.exists(p):
        problems.append('dist 里找不到 ' + rel)
        continue
    with open(p, 'rb') as f:
        if sha(f.read()) == h:
            same += 1
        else:
            diff += 1
            problems.append('内容不一致 ' + rel)

print('APK 内网页文件 %d 个：与 dist 一致 %d，不一致 %d' % (len(inapk), same, diff))
for p in problems[:10]:
    print('  ⚠️ ' + p)

key = 'klecks.86ec8e44.js'
if key in inapk:
    with open(os.path.join(DIST, key), 'rb') as f:
        bundle = f.read()
    has_sym = b'symmetry' in bundle.lower()
    has_vis = b'__kleksVisibleRect' in bundle
    print('主 bundle %s：%d 字节，含对称绘制补丁=%s，含可见区渲染补丁=%s'
          % (key, len(bundle), has_sym, has_vis))
