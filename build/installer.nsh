!macro customInstall
  ; Older FrameForge versions installed on quit without --force-run. Reopen those updates too.
  ; The normal updater handles --force-run itself, so only launch here when that flag is absent.
  ${if} ${isUpdated}
  ${andIf} ${Silent}
    ${ifNot} ${isForceRun}
      HideWindow
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
    ${endIf}
  ${endIf}
!macroend
