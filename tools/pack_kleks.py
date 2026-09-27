import os, shutil, json, pathlib

app = pathlib.Path(r"E:\dev\Kleks桌面版\resources\app")
if app.exists():
    shutil.rmtree(app)
app.mkdir(parents=True)

src = pathlib.Path(r"E:\dev\klecks-desktop")
shutil.copy(src / "main.js", app / "main.js")
shutil.copy(src / "klecks-icon.ico", app / "klecks-icon.ico")

pkg = app / "package.json"
pkg.write_text(json.dumps({
    "name": "kleks-desktop",
    "productName": "Kleks",
    "version": "1.0.0",
    "description": "Klecks (Kleki open-source) offline desktop shell",
    "main": "main.js",
    "license": "MIT",
}, indent=2), encoding="utf-8")

shutil.copytree(src / "dist", app / "dist")

default_app = pathlib.Path(r"E:\dev\Kleks桌面版\resources\default_app.asar")
if default_app.exists():
    default_app.unlink()

exe = pathlib.Path(r"E:\dev\Kleks桌面版\electron.exe")
target = pathlib.Path(r"E:\dev\Kleks桌面版\Kleks.exe")
if target.exists():
    target.unlink()
exe.rename(target)

print("app dir:", sorted(p.name for p in app.iterdir()))
print("dist files:", len(list((app / "dist").iterdir())))
print("exe:", target, round(target.stat().st_size / 1e6, 1), "MB")
total = sum(f.stat().st_size for f in pathlib.Path(r"E:\dev\Kleks桌面版").rglob("*") if f.is_file())
print("portable total size MB:", round(total / 1e6, 1))
