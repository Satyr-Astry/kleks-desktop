#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Kleks 网页产物打成 Android APK —— 不依赖 Gradle / androidx。

    python build.py [--dist <网页产物目录>] [--sdk <Android SDK 根目录>] [--out <输出目录>]

流程：生成图标 → 拷 assets/web → aapt2 compile/link → javac → d8 → 塞进 APK
      → zipalign → apksigner 签名 → 自检（badging / 签名 / 内容清单）

为什么不用 Gradle：环境里没有 Android Studio，装 Gradle + AGP 要走 Maven 仓库、
体积与不确定性都大；这个外壳只有 4 个 java 文件、零第三方依赖，
用 build-tools 里的 aapt2/d8 直接编出 APK 又快又可控。
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

PKG = 'com.satyr.astry.kleks'
APP_NAME = 'Kleks'
VERSION_CODE = 1
VERSION_NAME = '1.0.0'
MIN_SDK = 24
TARGET_SDK = 34

DEFAULT_SDK = r'E:\dev\android-sdk'
DEFAULT_DIST = r'E:\dev\Kleks桌面版\resources\app\dist'
ICON_SRC = r'E:\dev\Kleks桌面版\resources\app\klecks-icon.ico'   # 由 tools/make_icon.py 生成

KEYSTORE = os.path.join(HERE, 'keystore', 'kleks.jks')
KEY_ALIAS = 'kleks'
KEY_PASS = 'kleksandroid'      # 侧载自用；换正式发布请自己重新生成并保管好
JDK = r'C:\Program Files\Java\jdk-17'

DENSITIES = [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]


def log(msg):
    print('[apk] ' + msg)


def run(cmd, **kw):
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        sys.exit('命令失败(%d): %s' % (r.returncode, ' '.join(str(c) for c in cmd)))


def gen_icons():
    try:
        from PIL import Image
    except ImportError:
        sys.exit('需要 Pillow：pip install pillow')
    src = ICON_SRC
    if not os.path.exists(src):
        cache = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'klecks-icon.png')
        if not os.path.exists(cache):
            sys.exit('找不到图标源：%s' % src)
        src = cache
    img = Image.open(src).convert('RGBA')
    made = []
    for name, size in DENSITIES:
        d = os.path.join(HERE, 'res', 'mipmap-' + name)
        os.makedirs(d, exist_ok=True)
        out = os.path.join(d, 'ic_launcher.png')
        img.resize((size, size), Image.LANCZOS).save(out)
        made.append((name, size, os.path.getsize(out)))
    log('图标已生成：' + ', '.join('%s(%dpx %dB)' % m for m in made))


def prune_stale_chunks(web):
    """Parcel 每次构建换 hash 文件名；dist 被反复覆盖就会留下旧 chunk（本机实测积了 7 份共 5.3 MB）。
    从 *.html 出发反复扫描引用，收敛后删掉没被任何文件引用的 klecks.<hash>.js。"""
    import re
    files = []
    for r, _d, fs in os.walk(web):
        for f in fs:
            files.append(os.path.relpath(os.path.join(r, f), web).replace(os.sep, '/'))
    texts = {}
    for n in files:
        if n.endswith(('.html', '.js', '.json', '.css')):
            p = os.path.join(web, n.replace('/', os.sep))
            try:
                texts[n] = open(p, encoding='utf-8', errors='ignore').read()
            except OSError:
                pass
    # 入口只有 html；其余靠引用扫描收敛（注意：一开始就把所有 .js 都放进 keep 的话，
    # 旧 chunk 永远不会被判成"没人引用"——第一版就是这么写错的）
    keep = {n for n in files if n.endswith('.html')}
    frontier = set(keep)
    seen = set()
    pattern = re.compile(r'[A-Za-z0-9_.\-]+\.(?:js|css|json|wasm|png|jpg|webp|svg|woff2?|ttf)')
    while frontier:
        nxt = set()
        for n in frontier:
            if n in seen or n not in texts:
                continue
            seen.add(n)
            for ref in pattern.findall(texts[n]):
                if ref in files:
                    keep.add(ref)
                    nxt.add(ref)
        frontier = nxt
    stale = [n for n in files if re.match(r'^klecks\.[0-9a-f]{6,}\.js$', n) and n not in keep]
    freed = 0
    for n in stale:
        p = os.path.join(web, n.replace('/', os.sep))
        freed += os.path.getsize(p)
        os.remove(p)
    if stale:
        log('清掉 %d 个没被引用的旧 chunk（省 %.1f MB）：%s'
            % (len(stale), freed / 1048576, ', '.join(stale)))
    return len(stale)


def stage_assets(dist):
    web = os.path.join(HERE, 'assets', 'web')
    shutil.rmtree(web, ignore_errors=True)
    if os.path.exists(web):
        # 偶尔有文件被占用（上一步的构建/杀毒扫描），再试一次并报清楚
        shutil.rmtree(web)
    os.makedirs(os.path.dirname(web), exist_ok=True)
    shutil.copytree(dist, web, dirs_exist_ok=True)
    # 源码映射只有开发调试用，手机包里白占体积
    dropped = 0
    for r, _d, fs in os.walk(web):
        for f in fs:
            if f.endswith('.map'):
                os.remove(os.path.join(r, f))
                dropped += 1
    prune_stale_chunks(web)
    n = sum(len(f) for _r, _d, f in os.walk(web))
    total = sum(os.path.getsize(os.path.join(r, f)) for r, _d, fs in os.walk(web) for f in fs)
    if not os.path.exists(os.path.join(web, 'index.html')):
        sys.exit('网页产物里没有 index.html，dist 目录给错了吧')
    log('assets/web：%d 个文件，%.1f MB（丢掉 %d 个 .map）' % (n, total / 1048576, dropped))


def build_apk(sdk, outdir):
    bt = os.path.join(sdk, 'build-tools', '34.0.0')
    android_jar = os.path.join(sdk, 'platforms', 'android-34', 'android.jar')
    aapt2 = os.path.join(bt, 'aapt2.exe')
    d8 = os.path.join(bt, 'lib', 'd8.jar')
    zipalign = os.path.join(bt, 'zipalign.exe')
    apksigner = os.path.join(bt, 'apksigner.bat')
    javac = os.path.join(JDK, 'bin', 'javac.exe')
    java = os.path.join(JDK, 'bin', 'java.exe')
    keytool = os.path.join(JDK, 'bin', 'keytool.exe')
    for p in (aapt2, android_jar, javac, java, keytool):
        if not os.path.exists(p):
            sys.exit('缺少工具：%s' % p)

    b = os.path.join(HERE, 'build')
    shutil.rmtree(b, ignore_errors=True)
    os.makedirs(b)

    # 1) 资源 → 编译 → 链接（-A 把整个 assets 收进 APK）
    log('aapt2 compile/link')
    reszip = os.path.join(b, 'res.zip')
    run([aapt2, 'compile', '--dir', os.path.join(HERE, 'res'), '-o', reszip])
    gen = os.path.join(b, 'gen')
    os.makedirs(gen)
    base_apk = os.path.join(b, 'base.apk')
    run([aapt2, 'link', '-o', base_apk,
         '-I', android_jar,
         '--manifest', os.path.join(HERE, 'AndroidManifest.xml'),
         '-R', reszip,
         '-A', os.path.join(HERE, 'assets'),
         '--java', gen,
         '--min-sdk-version', str(MIN_SDK),
         '--target-sdk-version', str(TARGET_SDK),
         '--version-code', str(VERSION_CODE),
         '--version-name', VERSION_NAME,
         '--auto-add-overlay'])

    # 2) javac
    log('javac')
    sources = glob.glob(os.path.join(HERE, 'java', '**', '*.java'), recursive=True)
    sources += glob.glob(os.path.join(gen, '**', '*.java'), recursive=True)
    classes = os.path.join(b, 'classes')
    os.makedirs(classes)
    run([javac, '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-nowarn',
         '-bootclasspath', android_jar, '-d', classes] + sources)

    # 3) d8 → classes.dex
    log('d8')
    dexdir = os.path.join(b, 'dex')
    os.makedirs(dexdir)
    classfiles = []
    for r, _d, fs in os.walk(classes):
        classfiles += [os.path.join(r, f) for f in fs if f.endswith('.class')]
    run([java, '-cp', d8, 'com.android.tools.r8.D8',
         '--lib', android_jar, '--min-api', str(MIN_SDK), '--output', dexdir] + classfiles)

    # 4) classes.dex 塞进 APK
    log('打包 classes.dex')
    apk = os.path.join(b, 'unsigned.apk')
    shutil.copy(base_apk, apk)
    with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(dexdir, 'classes.dex'), 'classes.dex')

    # 5) zipalign
    aligned = os.path.join(b, 'aligned.apk')
    run([zipalign, '-f', '-p', '4', apk, aligned])

    # 6) 签名（首次自动生成 keystore；**这个文件要留好，以后升级要用同一把**）
    os.makedirs(os.path.dirname(KEYSTORE), exist_ok=True)
    if not os.path.exists(KEYSTORE):
        log('生成签名密钥：%s' % KEYSTORE)
        run([keytool, '-genkeypair', '-keystore', KEYSTORE, '-alias', KEY_ALIAS,
             '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
             '-storepass', KEY_PASS, '-keypass', KEY_PASS,
             '-dname', 'CN=%s, O=Satyr_Astry, C=TW' % APP_NAME])
    os.makedirs(outdir, exist_ok=True)
    outapk = os.path.join(outdir, '%s-%s-android.apk' % (APP_NAME, VERSION_NAME))
    log('apksigner 签名')
    run([apksigner, 'sign', '--ks', KEYSTORE, '--ks-key-alias', KEY_ALIAS,
         '--ks-pass', 'pass:' + KEY_PASS, '--key-pass', 'pass:' + KEY_PASS,
         '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true',
         '--out', outapk, aligned])

    # 7) 自检
    log('== 自检 ==')
    r = subprocess.run([apksigner, 'verify', '--print-certs', '-v', outapk],
                       capture_output=True, text=True)
    print(r.stdout.strip()[:600])
    if r.returncode != 0:
        sys.exit('签名校验失败')
    r = subprocess.run([aapt2, 'dump', 'badging', outapk], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if line.startswith(('package:', 'application-label', 'sdkVersion', 'targetSdkVersion',
                            'launchable-activity', 'uses-permission')):
            print('  ' + line)
    with zipfile.ZipFile(outapk) as z:
        names = z.namelist()
        web = [n for n in names if n.startswith('assets/web/')]
        print('  APK 内容：%d 个条目，其中 assets/web %d 个；classes.dex=%s'
              % (len(names), len(web), 'classes.dex' in names))
        icons = [n for n in names if n.startswith('res/mipmap-') and n.endswith('ic_launcher.png')]
        # aapt2 会把限定符写进路径（res/mipmap-mdpi-v4/...），所以按前缀判断而不是写死名字
        checks = [('AndroidManifest.xml', 'AndroidManifest.xml' in names),
                  ('resources.arsc', 'resources.arsc' in names),
                  ('classes.dex', 'classes.dex' in names),
                  ('assets/web/index.html', 'assets/web/index.html' in names),
                  ('launcher icon ×%d' % len(icons), len(icons) >= 4)]
        for label, ok in checks:
            print(('  ✅ ' if ok else '  ❌ ') + label)
        if not all(ok for _l, ok in checks):
            sys.exit('自检未通过')
    log('✅ 产物：%s  (%.1f MB)' % (outapk, os.path.getsize(outapk) / 1048576))
    return outapk


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dist', default=DEFAULT_DIST)
    ap.add_argument('--sdk', default=DEFAULT_SDK)
    ap.add_argument('--out', default=HERE)
    args = ap.parse_args()
    if not os.path.isdir(args.dist):
        sys.exit('网页产物目录不存在：%s' % args.dist)
    gen_icons()
    stage_assets(args.dist)
    build_apk(args.sdk, args.out)


if __name__ == '__main__':
    main()
