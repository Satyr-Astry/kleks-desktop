; Kleks 安装包（NSIS 3.x）
; 按用户安装（不需要管理员权限，不弹 UAC），默认装到 %LOCALAPPDATA%\Programs\Kleks
; 可选：桌面快捷方式 / 开始菜单快捷方式 / 注册图片"打开方式"
; 卸载默认保留用户数据（Kleks-Data：自动保存与设置），会先问一次。

Unicode true
ManifestDPIAware true

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APP_NAME "Kleks"
!define APP_VERSION "1.0.0"
!define APP_PUBLISHER "Satyr_Astry"
!define APP_EXE "Kleks.exe"
!define APP_ID "Kleks"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "Kleks-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32

VIProductVersion "1.0.0.0"
VIAddVersionKey /LANG=2052 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT License"

!define MUI_ICON "klecks-icon.ico"
!define MUI_UNICON "klecks-icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------- 安装

Section "应用程序（必需）" SecApp
    SectionIn RO
    SetOutPath "$INSTDIR"
    ; Electron 运行时
    File "stage\*.exe"
    File "stage\*.dll"
    File "stage\*.pak"
    File "stage\*.bin"
    File "stage\*.dat"
    File "stage\*.json"
    File "stage\version"
    File "stage\LICENSE"
    File "stage\LICENSES.chromium.html"
    File "stage\README.md"
    SetOutPath "$INSTDIR\locales"
    File "stage\locales\*.*"
    SetOutPath "$INSTDIR\resources"
    SetOutPath "$INSTDIR\resources\app"
    File /r "stage\resources\app\*.*"

    ; 注册表：卸载信息 + 安装目录
    WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}（Klecks 绘画）"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher" "${APP_PUBLISHER}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "EstimatedSize" "$0"

    WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "桌面快捷方式" SecDesktop
    CreateShortcut "$DESKTOP\${APP_NAME} 绘画.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

Section "开始菜单快捷方式" SecStartMenu
    CreateDirectory "$SMPROGRAMS\${APP_NAME}"
    CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME} 绘画.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
    CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
SectionEnd

Section "注册图片「打开方式」（png / jpg / webp / bmp / psd）" SecAssoc
    ExecWait '"$INSTDIR\${APP_EXE}" --register-file-assoc'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
!insertmacro MUI_DESCRIPTION_TEXT ${SecApp} "Kleks 主程序（Electron 运行时 + 绘画应用，约 340 MB）。"
!insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "在桌面创建「Kleks 绘画」快捷方式。"
!insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenu} "在开始菜单创建快捷方式与卸载入口。"
!insertmacro MUI_DESCRIPTION_TEXT ${SecAssoc} "把 Kleks 加进图片的「打开方式」列表（不会抢当前默认程序，可随时用 --unregister-file-assoc 取消）。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function .onInit
    ; 已经在装？提示并建议先卸载（静默安装时不能弹框，否则自动化会卡死）
    IfSilent done
    ReadRegStr $0 HKCU "Software\${APP_ID}" "InstallDir"
    StrCmp $0 "" done
    MessageBox MB_OKCANCEL|MB_ICONQUESTION "检测到已安装的 ${APP_NAME}：$\n$0$\n$\n继续安装会覆盖现有文件（用户数据与自动保存不受影响）。是否继续？" IDOK done
    Abort
    done:
FunctionEnd

; ---------------------------------------------------------------- 卸载

Section "Uninstall"
    ; 卸载过程写日志，便于无人值守验收
    FileOpen $9 "$TEMP\kleks-uninstall.log" w
    FileWrite $9 "start$\r$\n"

    ; 先撤销文件关联（用还在的程序自己来做）
    ExecWait '"$INSTDIR\${APP_EXE}" --unregister-file-assoc'
    FileWrite $9 "unregister-assoc done$\r$\n"

    Delete "$DESKTOP\${APP_NAME} 绘画.lnk"
    Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} 绘画.lnk"
    Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
    RMDir "$SMPROGRAMS\${APP_NAME}"
    FileWrite $9 "shortcuts deleted$\r$\n"

    ; 用户数据（自动保存/设置）：默认保留。
    ; 静默卸载（/S）不能弹框——否则自动化会卡在对话框上，后面的删除全不执行。
    IfSilent keepData
    IfFileExists "$INSTDIR\Kleks-Data\*.*" 0 delFiles
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除用户数据？$\n$\n$INSTDIR\Kleks-Data$\n（里面是你的自动保存副本与设置，删除后无法恢复）" IDNO keepData
    RMDir /r "$INSTDIR\Kleks-Data"
    FileWrite $9 "userdata deleted$\r$\n"
    Goto delFiles
    keepData:
    FileWrite $9 "userdata kept$\r$\n"
    delFiles:

    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\resources"
    Delete "$INSTDIR\*.exe"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\version"
    Delete "$INSTDIR\LICENSE"
    Delete "$INSTDIR\LICENSES.chromium.html"
    Delete "$INSTDIR\README.md"
    Delete "$INSTDIR\*.log"
    RMDir "$INSTDIR"
    FileWrite $9 "files deleted$\r$\n"

    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
    DeleteRegKey HKCU "Software\${APP_ID}"
    FileWrite $9 "registry cleaned$\r$\n"
    FileClose $9
SectionEnd

Function un.onInit
FunctionEnd
