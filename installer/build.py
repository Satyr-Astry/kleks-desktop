#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从"已组装好的便携目录"生成 Windows 安装包（NSIS）。

    python build.py <便携目录> [--keep-stage]

做三件事：
  1) 复制便携目录 → ./stage，并**白名单式**剔除用户数据与诊断产物
     （早期版本用 rm resources/app/*.json 一把梭，把 package.json 也删了 →
       装完的程序秒退。所以这里只删已知名单，并断言必需文件存在。）
  2) 断言：Kleks.exe / resources/app/{main.js,package.json,dist/index.html} / locales / version
     以及"没有非 ASCII 文件名"（makensis 在非 UTF-8 代码页下读不到这类名字）
  3) 调 makensis 编译 kleks.nsi
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.join(HERE, 'stage')

# 绝不打进安装包的东西（用户数据 + 自检产物）
PRUNE_ROOT = ['Kleks-Data']
PRUNE_ROOT_GLOB = ('app-log.txt', 'smoke-run.log')
# 根目录下的通配剔除（自检产物；含中文名的也在这里干掉，否则 makensis 读不到）
PRUNE_ROOT_PATTERNS = ('smoke-*.png', 'perf-probe*', 'brush-probe.json',
                       '自检结果.json', '笔刷自检结果.json', '演示-*.png',
                       'kleks-demo-screenshot.png', '*.log')

PRUNE_APP = [
    'smoke-result.json', 'perf-probe.json', 'perf-probe-screenshot.png',
    'brush-probe.json', 'probe-result.json', '自检结果.json', '笔刷自检结果.json',
    'kleks-demo-screenshot.png', '演示-对称绘制.png',
]
REQUIRED = [
    'Kleks.exe',
    os.path.join('resources', 'app', 'main.js'),
    os.path.join('resources', 'app', 'package.json'),
    os.path.join('resources', 'app', 'dist', 'index.html'),
    os.path.join('locales', 'zh-CN.pak'),
    'version',
]

MAKENSIS = [r'C:\Program Files (x86)\NSIS\makensis.exe', 'makensis']


def log(msg):
    print(f'[build] {msg}')


def find_makensis():
    for cand in MAKENSIS:
        if os.path.isabs(cand):
            if os.path.exists(cand):
                return cand
        else:
            p = shutil.which(cand)
            if p:
                return p
    sys.exit('找不到 makensis.exe —— 装 NSIS 3.x（winget install NSIS.NSIS）')


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = os.path.abspath(sys.argv[1])
    if not os.path.isdir(src):
        sys.exit(f'便携目录不存在: {src}')

    log(f'从 {src} 复制到 stage/')
    shutil.rmtree(STAGE, ignore_errors=True)
    shutil.copytree(src, STAGE)

    for name in PRUNE_ROOT:
        shutil.rmtree(os.path.join(STAGE, name), ignore_errors=True)
    for pat in PRUNE_ROOT_GLOB:
        for f in [n for n in os.listdir(STAGE) if n == pat]:
            os.remove(os.path.join(STAGE, f))
    import fnmatch
    for pat in PRUNE_ROOT_PATTERNS:
        for n in os.listdir(STAGE):
            p = os.path.join(STAGE, n)
            if os.path.isfile(p) and fnmatch.fnmatch(n, pat):
                os.remove(p)
    appdir = os.path.join(STAGE, 'resources', 'app')
    for name in PRUNE_APP:
        p = os.path.join(appdir, name)
        if os.path.exists(p):
            os.remove(p)
    log('已剔除：Kleks-Data / 日志 / 自检 JSON 与截图')

    # ---- 断言 1：必需文件都在（防止又把自己需要的文件删掉）
    missing = [p for p in REQUIRED if not os.path.exists(os.path.join(STAGE, p))]
    if missing:
        sys.exit('缺少必需文件（安装包会装出打不开的程序）:\n  ' + '\n  '.join(missing))

    # ---- 断言 2：没有非 ASCII 文件名
    bad = []
    for root, _dirs, files in os.walk(STAGE):
        for f in files:
            if any(ord(c) > 127 for c in f):
                bad.append(os.path.join(root, f))
    if bad:
        sys.exit('存在非 ASCII 文件名（makensis 读不到）:\n  ' + '\n  '.join(bad))

    size = sum(os.path.getsize(os.path.join(r, f))
               for r, _d, fs in os.walk(STAGE) for f in fs)
    log(f'stage 校验通过：{len(REQUIRED)} 项必需文件齐全，无非法文件名，{size/1048576:.0f} MB')

    nsi = os.path.join(HERE, 'kleks.nsi')
    mk = find_makensis()
    log(f'编译 {os.path.basename(nsi)} （solid LZMA，几百 MB 要几分钟）')
    r = subprocess.run([mk, nsi], cwd=HERE)
    if r.returncode != 0:
        sys.exit(f'makensis 失败，退出码 {r.returncode}')
    outs = [f for f in os.listdir(HERE) if f.lower().endswith('.exe') and f.startswith('Kleks-Setup')]
    for f in sorted(outs):
        p = os.path.join(HERE, f)
        log(f'✅ {f}  {os.path.getsize(p)/1048576:.1f} MB')


if __name__ == '__main__':
    main()
