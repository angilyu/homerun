; Homerun's hooks into Tauri's NSIS installer (§11 Windows, §18 row 137).
;
; The installer is per user (bundle.windows.nsis.installMode "currentUser"): no admin prompt.
; Tauri's template already does several things:
; - the Start menu shortcut carries the AppUserModelID toasts use (com.angilyu.homerun);
; - uninstalling deletes the HKCU Run value, but updating doesn't;
; - updates run as `setup.exe /P /UPDATE`.
; These hooks add three things:
;
; - The folder. The template's per-user default is $LOCALAPPDATA\Homerun, which is Homerun's data
;   folder (§5.1). Programs go in $LOCALAPPDATA\Programs\Homerun instead. The data folder is
;   refused even when typed in, so uninstalling can never reach the data.
; - The command-line tool. The release CLI is bundled as homerun-cli.exe. It is moved to
;   bin\homerun.exe, so that `homerun` runs it once Settings puts bin on the user's Path. The
;   installer never edits Path itself.
; - Uninstalling (not updating) takes bin off the user's Path through the shell, which knows how,
;   and removes bin.

!include LogicLib.nsh

!define HOMERUN_DATA_DIR "$LOCALAPPDATA\Homerun"
!define HOMERUN_PROGRAM_DIR "$LOCALAPPDATA\Programs\Homerun"

; Runs before the directory page shows (interactive installs only; silent ones never get here).
!define MUI_CUSTOMFUNCTION_GUIINIT HomerunGuiInit
Function HomerunGuiInit
  ${If} $INSTDIR == "${HOMERUN_DATA_DIR}"
    StrCpy $INSTDIR "${HOMERUN_PROGRAM_DIR}"
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; Silent installs, and anyone who typed the data folder in.
  ${If} $INSTDIR == "${HOMERUN_DATA_DIR}"
    StrCpy $INSTDIR "${HOMERUN_PROGRAM_DIR}"
    CreateDirectory "$INSTDIR"
    SetOutPath "$INSTDIR"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\homerun-cli.exe"
    CreateDirectory "$INSTDIR\bin"
    ; A terminal may be running the old CLI. A running exe can be renamed but not overwritten.
    Delete "$INSTDIR\bin\homerun.exe"
    ${If} ${FileExists} "$INSTDIR\bin\homerun.exe"
      Delete "$INSTDIR\bin\homerun.exe.old"
      Rename "$INSTDIR\bin\homerun.exe" "$INSTDIR\bin\homerun.exe.old"
      Delete /REBOOTOK "$INSTDIR\bin\homerun.exe.old"
    ${EndIf}
    Rename "$INSTDIR\homerun-cli.exe" "$INSTDIR\bin\homerun.exe"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} ${FileExists} "$INSTDIR\homerun.exe"
    ExecWait '"$INSTDIR\homerun.exe" --remove-cli-path'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Delete /REBOOTOK "$INSTDIR\bin\homerun.exe"
    Delete /REBOOTOK "$INSTDIR\bin\homerun.exe.old"
    RMDir /REBOOTOK "$INSTDIR\bin"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
