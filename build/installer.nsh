; The builder uses the product name for a fresh install's folder. Its directory
; page would append that name to an existing folder named Folia on upgrade.
!macro customPageAfterChangeDir
  Function preserveExistingInstallDirectory
    Push $0
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ClearErrors
    ${If} $0 != ""
    ${AndIf} $INSTDIR == $0
      Pop $0
      Return
    ${EndIf}
    Pop $0
    Call instFilesPre
  FunctionEnd

  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE preserveExistingInstallDirectory
!macroend

!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING

  ; PowerShell detects any process in the install folder. Its tasklist fallback
  ; only checks Markaloo.exe, so check the previous executable separately.
  ${If} $IsPowerShellAvailable != 0
  ${AndIf} ${FileExists} "$INSTDIR\Folia.exe"
    !insertmacro FIND_PROCESS "Folia.exe" $R0
    ${If} $R0 == 0
      ${If} ${isUpdated}
        Sleep 1000
        Goto closeLegacyApp
      ${EndIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK closeLegacyApp
      Quit

      closeLegacyApp:
      DetailPrint "$(appClosing)"
      !insertmacro KILL_PROCESS "Folia.exe" 0
      Sleep 300
      StrCpy $R1 0

      waitForLegacyApp:
        IntOp $R1 $R1 + 1
        !insertmacro FIND_PROCESS "Folia.exe" $R0
        ${If} $R0 != 0
          Goto legacyAppClosed
        ${EndIf}
        Sleep 1000
        !insertmacro KILL_PROCESS "Folia.exe" 1
        !insertmacro FIND_PROCESS "Folia.exe" $R0
        ${If} $R0 != 0
          Goto legacyAppClosed
        ${EndIf}
        ${If} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY waitForLegacyApp
          Quit
        ${EndIf}
        Goto waitForLegacyApp

      legacyAppClosed:
    ${EndIf}
  ${EndIf}
!macroend
