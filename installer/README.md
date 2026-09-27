# 安装包（Windows，NSIS）

生成一个**按用户安装**的 `Kleks-Setup-1.0.0.exe`（不需要管理员权限，不弹 UAC）。

## 安装时可选的东西

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 桌面快捷方式 | ✅ 勾选 | 失败/不想要就不勾 |
| 开始菜单快捷方式 | ✅ 勾选 | 含一个「卸载 Kleks」入口 |
| 注册图片「打开方式」 | ☐ 不勾 | 把 Kleks 加进 png/jpg/webp/bmp/psd 的「打开方式」列表；**不会抢当前默认程序**，随时可用 `Kleks.exe --unregister-file-assoc` 撤销 |
| 安装完成后立即启动 | ✅ 勾选 | |

安装位置默认 `%LOCALAPPDATA%\Programs\Kleks`，可以在向导里改。

卸载时**默认保留** `Kleks-Data`（自动保存副本与设置），会先问一次要不要一起删。

## 自己编译

```powershell
# 1) 准备一个已经组装好的便携目录（含 Electron 运行时 + resources\app）
#    见仓库根 README 的「快速开始」
# 2) 把便携目录清干净后放到脚本同级的 stage\
robocopy <便携目录> stage /E
rmdir /s /q stage\Kleks-Data          # 用户数据绝不能打进安装包
# 3) 编译（NSIS 3.x；路径都相对于 kleks.nsi 所在目录）
makensis kleks.nsi
```

脚本里对 `stage\` 和图标用**相对路径**（makensis 默认会切到脚本所在目录），所以整份 `installer/` 拷到哪台机器都能直接编译。图标由 `tools/make_icon.py` 从上游 PNG 现场生成（仓库不分发上游图标，见 `NOTICE.md`）。

## 静默安装 / 卸载（自动化用）

```cmd
Kleks-Setup-1.0.0.exe /S /D=C:\temp\Kleks      :: /D 必须是最后一个参数、不能加引号
"%LOCALAPPDATA%\Programs\Kleks\Uninstall.exe" /S
```
