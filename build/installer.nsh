; Keep electron-builder's installer, elevation and uninstall safeguards.
; Override its shared running check: never close an app or discard unsaved work.
!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT MarkalooRestoreInteractiveSetup
  Function MarkalooRestoreInteractiveSetup
    IfSilent done
    Push $0
    ; Old clients hide setup. Restore after NSIS applies its startup show state.
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i 0x0112, p 0xF120, p 0) i.r0'
    StrCmp $0 0 failed
    Pop $0
    Return
    failed:
    Pop $0
    MessageBox MB_OK|MB_ICONSTOP "Markaloo setup could not show its window. Run setup again."
    SetErrorLevel 2
    Quit
    done:
  FunctionEnd
!endif

!macro customCheckAppRunning
  Push $R0
  Push $R1
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 != 603
    DetailPrint "Close Markaloo yourself, then run setup again."
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close Markaloo yourself, then run setup again. No application was closed." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${nsProcess::FindProcess} "Folia.exe" $R0
  ${If} $R0 != 603
    DetailPrint "Close Folia yourself, then run setup again."
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close Folia yourself, then run setup again. No application was closed." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    ; Finish old removal before stock writes payload, shortcuts or associations.
    InitPluginsDir
    File /oname=$PLUGINSDIR\legacy-install.ps1 "${PROJECT_DIR}\src\legacy-install.ps1"
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\legacy-install.ps1" -Action BeforeInstallCleanup`
    Pop $R0
    Pop $R1
    ${If} $R0 != 0
      DetailPrint "Folia removal could not be completed: $R1"
      MessageBox MB_OK|MB_ICONEXCLAMATION "Folia removal could not be completed. Its settings are kept; the old installation may remain. Markaloo setup will continue without retrying removal."
    ${EndIf}
  !endif
  Pop $R1
  Pop $R0
!macroend
