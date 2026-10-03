; Unsigned per-machine installer for the packaged Quant Research Office build.
; Built by scripts/installer-release.mjs; it passes SourceDir, AppVersion, SourceCommit, OutputDir and OutputBase.
; Program Files keeps the default ACL (Users read/execute, no write), which is what the
; QRO-Agent isolation account needs. Workspace data in %APPDATA% is never touched.

#ifndef SourceDir
  #error SourceDir must be defined
#endif

[Setup]
AppId={{6F3B2C1A-9D4E-4B7A-8C21-5E0F7A9B3D64}
AppName=Quant Research Office
AppVersion={#AppVersion}
AppVerName=Quant Research Office {#AppVersion}
AppPublisher=Quant Research Office (unsigned)
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Quant Research Office installer ({#SourceCommit})
DefaultDirName={autopf}\Quant Research Office
DisableDirPage=yes
DefaultGroupName=Quant Research Office
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no
UninstallDisplayIcon={app}\Quant Research Office.exe
UninstallDisplayName=Quant Research Office
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Replace the previous version's files entirely so obsolete files cannot survive an upgrade.
Type: filesandordirs; Name: "{app}\*"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Quant Research Office"; Filename: "{app}\Quant Research Office.exe"
Name: "{autodesktop}\Quant Research Office"; Filename: "{app}\Quant Research Office.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Quant Research Office.exe"; Description: "{cm:LaunchProgram,Quant Research Office}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallDelete]
; Only administrators can write here, so anything left in the install folder belongs to this app; remove it all.
Type: filesandordirs; Name: "{app}"
