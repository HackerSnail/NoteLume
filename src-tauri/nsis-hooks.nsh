; NoteLume 关联文件图标。
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
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 关联键删掉后通知一次，外壳不会继续拿缓存里的旧图标
  !insertmacro UPDATEFILEASSOC
!macroend
