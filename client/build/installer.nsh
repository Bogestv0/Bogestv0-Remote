!macro customInstall
  nsExec::ExecToLog '"$INSTDIR\resources\service\Bogestv0Service.exe" install'
  nsExec::ExecToLog '"$INSTDIR\resources\service\Bogestv0Service.exe" start'
!macroend
!macro customUnInstall
  nsExec::ExecToLog '"$INSTDIR\resources\service\Bogestv0Service.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\resources\service\Bogestv0Service.exe" uninstall'
!macroend
