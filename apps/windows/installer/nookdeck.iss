; Nookdeck-Setup.exe: per-user installer of the Windows tray app (spec desktop-apps A4). No admin rights.
;
; Build (Inno Setup 6, iscc.exe):
;   iscc /DAppVersion=0.4.0 /DDistDir=..\dist /DAgentExe=..\..\..\dist\nookdeck-windows-x64.exe /DSharedDir=..\..\shared installer\nookdeck.iss
; What ends up where:
;   %LOCALAPPDATA%\Programs\Nookdeck\Nookdeck.exe          the tray app
;   %LOCALAPPDATA%\Programs\Nookdeck\agent\nookdeck.exe    the agent that ships with this version
; On first run (and after every update) `Nookdeck.exe --setup` installs or adopts the agent into %LOCALAPPDATA%\Nookdeck\bin (the
; same place setup.ps1 uses) and registers the sign-in task, so a CLI install is adopted, not duplicated.
; The uninstaller removes the tray app, the agent, the sign-in task and our Claude/Codex hooks. ~/.nookdeck (layout, paired phones)
; stays unless the owner ticks the box.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef DistDir
  #define DistDir "..\dist"
#endif
#ifndef AgentExe
  #define AgentExe "..\..\..\dist\nookdeck-windows-x64.exe"
#endif
#ifndef SharedDir
  #define SharedDir "..\..\shared"
#endif

[Setup]
AppId={{7A1D2C54-3F0B-4B8E-9C6A-4E2F5B9D0A11}
AppName=Nookdeck
AppVersion={#AppVersion}
AppVerName=Nookdeck {#AppVersion}
AppPublisher=Nookdeck
AppPublisherURL=https://nookdeck.app
AppSupportURL=https://github.com/howznguyen/nookdeck/issues
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Nookdeck
DefaultGroupName=Nookdeck
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#DistDir}
OutputBaseFilename=Nookdeck-Setup
SetupIconFile={#SharedDir}\icons\windows\app.ico
UninstallDisplayIcon={app}\Nookdeck.exe
UninstallDisplayName=Nookdeck
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
CloseApplicationsFilter=Nookdeck.exe
RestartApplications=no
UsePreviousAppDir=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startup"; Description: "Open Nookdeck when I sign in"; GroupDescription: "Startup:"
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#DistDir}\Nookdeck.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AgentExe}"; DestDir: "{app}\agent"; DestName: "nookdeck.exe"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Nookdeck"; Filename: "{app}\Nookdeck.exe"
Name: "{autodesktop}\Nookdeck"; Filename: "{app}\Nookdeck.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Nookdeck"; ValueData: """{app}\Nookdeck.exe"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
; install or adopt the agent (its own window-less log: %LOCALAPPDATA%\Nookdeck\tray.log), then start the tray
Filename: "{app}\Nookdeck.exe"; Parameters: "--setup"; StatusMsg: "Setting up the Nookdeck agent..."; Flags: runhidden waituntilterminated
Filename: "{app}\Nookdeck.exe"; Description: "Open Nookdeck"; Flags: postinstall nowait skipifsilent
Filename: "{app}\Nookdeck.exe"; Flags: nowait; Check: WizardSilent

[Code]
var
  RemoveData: Boolean;

function AgentPath(): String;
begin
  Result := ExpandConstant('{localappdata}\Nookdeck\bin\nookdeck.exe');
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  RemoveData := False;
  if not UninstallSilent then
    RemoveData := MsgBox('Also delete your Nookdeck data (layout, paired phones, icons, sounds) in ' + ExpandConstant('{userprofile}\.nookdeck') + '?' + #13#10 + #13#10 +
      'Choose No to keep it, for example to install Nookdeck again later.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    // the tray app and the agent first (their files are locked while they run)
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Nookdeck.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
    if FileExists(AgentPath()) then
    begin
      Exec(AgentPath(), 'service uninstall', '', SW_HIDE, ewWaitUntilTerminated, Code);
      Exec(AgentPath(), 'hooks remove', '', SW_HIDE, ewWaitUntilTerminated, Code);
      // the inbound rule needs administrator rights: one UAC prompt, as the PowerShell uninstaller does
      if not UninstallSilent then
        ShellExec('runas', ExpandConstant('{cmd}'), '/c netsh advfirewall firewall delete rule name=all program="' + AgentPath() + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
    end;
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    DelTree(ExpandConstant('{localappdata}\Nookdeck'), True, True, True);
    if RemoveData then
      DelTree(ExpandConstant('{userprofile}\.nookdeck'), True, True, True);
  end;
end;
