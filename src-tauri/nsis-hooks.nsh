; NoteLume 关联文件图标 + 中文系统下的快捷方式名。
;
; Tauri 的 APP_ASSOCIATE 把 .md / .markdown / .canvas 的 ProgID DefaultIcon 一律指到
; 主程序图标，资源管理器里这些文件和别的白纸文档长得一样。安装末尾把 ProgID 的图标
; 改成随包落地的文件图标（bundle.resources 已把 ico 放到 $INSTDIR\icons\）。
; ProgID 名就是 tauri.conf.json 里 fileAssociations[].name，改名字时这里要跟着改。
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\NoteLume Markdown\DefaultIcon" "" "$\"$INSTDIR\icons\file-markdown.ico$\",0"
  WriteRegStr SHCTX "Software\Classes\NoteLume Canvas\DefaultIcon" "" "$\"$INSTDIR\icons\file-canvas.ico$\",0"
  ; 让资源管理器重建图标缓存，装完不用注销或重启
  !insertmacro UPDATEFILEASSOC

  ; 产品名按界面语言走：中文环境显示「文溯」，其它语言仍是 NoteLume。
  ; 应用内由 i18n 的 ui.appName 决定，安装器这里按系统 UI 语言给快捷方式改名
  ; （Tauri 建快捷方式用的是固定 PRODUCTNAME，拿不到运行时语言）。
  ; 语言 ID 低字节 4 = LANG_CHINESE，覆盖简繁港新。$0/$1 用完弹回，别踩安装段的状态。
  Push $0
  Push $1
  System::Call 'kernel32::GetUserDefaultUILanguage()i.r0'
  IntOp $1 $0 & 255
  ${If} $1 = 4
    IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 +2
      Rename "$DESKTOP\${PRODUCTNAME}.lnk" "$DESKTOP\文溯.lnk"
    ; 安装段可能在钩子之后又补一次英文快捷方式（更新模式 / 完成页），这里再删一次，
    ; 保证中文环境桌面上只留「文溯」，不留两个指向同一 exe 的图标。
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 +2
      Rename "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$SMPROGRAMS\文溯.lnk"
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !if "${STARTMENUFOLDER}" != ""
      IfFileExists "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" 0 +2
        Rename "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$SMPROGRAMS\$AppStartMenuFolder\文溯.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    !endif
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 改过名的快捷方式 Tauri 自己的卸载段认不出来，这里补删，别留孤儿图标
  Delete "$DESKTOP\文溯.lnk"
  Delete "$SMPROGRAMS\文溯.lnk"
  !if "${STARTMENUFOLDER}" != ""
    Delete "$SMPROGRAMS\$AppStartMenuFolder\文溯.lnk"
  !endif
  ; 关联键删掉后通知一次，外壳不会继续拿缓存里的旧图标
  !insertmacro UPDATEFILEASSOC
!macroend
