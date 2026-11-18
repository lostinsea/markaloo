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

!ifndef BUILD_UNINSTALLER
  !ifdef allowToChangeInstallationDirectory
    !macro customInstallMode
      IfSilent markalooUpdateScopeDone
      Push $0
      Push $1
      Push $R9
      ${IfNot} ${isUpdated}
      ${OrIf} ${isForAllUsers}
      ${OrIf} ${isForCurrentUser}
        Goto markalooUpdateScopeRestore
      ${EndIf}

      ; Match stock scope and destination options, including empty /D= or /d=.
      ${GetParameters} $0
      ${GetOptions} $0 "/allusers" $1
      IfErrors +2
        Goto markalooUpdateScopeRestore
      ${GetOptions} $0 "/currentuser" $1
      IfErrors +2
        Goto markalooUpdateScopeRestore
      ${StdUtils.GetAllParameters} $0 "0"
      Push $0
      Push "/D="
      Call StrContains
      Pop $1
      StrCmp $1 "" 0 markalooUpdateScopeRestore
      Push $0
      Push "/d="
      Call StrContains
      Pop $1
      StrCmp $1 "" 0 markalooUpdateScopeRestore

      ; initMultiUser already read both product InstallLocations in the stock registry view.
      StrCmp $INSTDIR "" markalooUpdateScopeRestore
      ${If} $installMode == "all"
        StrCmp $perUserInstallationFolder "" 0 markalooUpdateScopeRestore
        StrCmp $perMachineInstallationFolder $INSTDIR 0 markalooUpdateScopeRestore
      ${ElseIf} $installMode == "CurrentUser"
        StrCmp $perMachineInstallationFolder "" 0 markalooUpdateScopeRestore
        StrCmp $perUserInstallationFolder $INSTDIR 0 markalooUpdateScopeRestore
      ${Else}
        Goto markalooUpdateScopeRestore
      ${EndIf}

      ; Reuse assistedInstaller's StrContains (defined later): instFilesPre appends
      ; APP_FILENAME on no match, even though the update skipped the directory page.
      Push $INSTDIR
      Push "${APP_FILENAME}"
      Call StrContains
      Pop $1
      StrCmp $1 "" markalooUpdateScopeRestore

      ; Missing paths (-1), directories and reparse entries are not file evidence.
      System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.r1'
      IntOp $1 $1 & 0x410
      StrCmp $1 0 0 markalooUpdateScopeRestore
      System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${UNINSTALL_FILENAME}") i.r1'
      IntOp $1 $1 & 0x410
      StrCmp $1 0 0 markalooUpdateScopeRestore

      ; The stock page owns the skip, scope selection and any elevation.
      ${If} $installMode == "all"
        StrCpy $isForceMachineInstall "1"
      ${Else}
        StrCpy $isForceCurrentInstall "1"
      ${EndIf}
      markalooUpdateScopeRestore:
      Pop $R9
      Pop $1
      Pop $0
      markalooUpdateScopeDone:
    !macroend
  !endif
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
