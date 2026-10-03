; Unsigned per-machine installer for the packaged Quant Research Office build.
; Built by scripts/installer-release.mjs; it passes SourceDir, AppVersion, SourceCommit, ReleasedAt (UTC ISO),
; OutputDir and OutputBase.
; Program Files keeps the default ACL (Users read/execute, no write), which is what the
; QRO-Agent isolation account needs. Workspace data in %APPDATA% is never touched.
;
; One installer does everything: on a PC that already has the office it opens a menu with
; Update/Reinstall, Roll back (to installers kept from earlier installs) and Uninstall.

#ifndef SourceDir
  #error SourceDir must be defined
#endif
#ifndef ReleasedAt
  #error ReleasedAt must be defined
#endif

#define AppIdGuid "{6F3B2C1A-9D4E-4B7A-8C21-5E0F7A9B3D64}"

[Setup]
AppId={{#AppIdGuid}
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

[Registry]
; Which build is installed, so a later installer knows whether it is an update or a rollback.
Root: HKLM; Subkey: "Software\Quant Research Office"; ValueType: string; ValueName: "SourceCommit"; ValueData: "{#SourceCommit}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Quant Research Office"; ValueType: string; ValueName: "ReleasedAt"; ValueData: "{#ReleasedAt}"

[Icons]
Name: "{autoprograms}\Quant Research Office"; Filename: "{app}\Quant Research Office.exe"
Name: "{autodesktop}\Quant Research Office"; Filename: "{app}\Quant Research Office.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Quant Research Office.exe"; Description: "{cm:LaunchProgram,Quant Research Office}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallDelete]
; Only administrators can write here, so anything left in the install folder belongs to this app; remove it all.
Type: filesandordirs; Name: "{app}"
; Kept installers for rollback go with the app.
Type: filesandordirs; Name: "{autopf}\Quant Research Office Versions"

[Code]
const
  ThisCommit = '{#SourceCommit}';
  ThisReleasedAt = '{#ReleasedAt}';
  KeepVersions = 3;

var
  ActionPage, RollbackPage: TInputOptionWizardPage;
  Installed, ShowMenu: Boolean;
  InstalledCommit, InstalledReleasedAt: String;
  RollbackFiles: TArrayOfString;
  Finished: Boolean;

function ArchiveDir: String;
begin
  Result := ExpandConstant('{autopf}\Quant Research Office Versions');
end;

function ArchiveIni: String;
begin
  Result := ArchiveDir + '\versions.ini';
end;

function UninstallKey: String;
begin
  Result := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#AppIdGuid}_is1';
end;

{ "2026-10-03T00:20:11.000Z" -> "2026-10-03 00:20 UTC"; unknown dates read as "an earlier build". }
function ShowDate(Iso: String): String;
begin
  if Length(Iso) >= 16 then
    Result := Copy(Iso, 1, 10) + ' ' + Copy(Iso, 12, 5) + ' UTC'
  else
    Result := 'an earlier build';
end;

function Describe(Commit, ReleasedAt: String): String;
begin
  if Commit = '' then
    Result := 'an earlier build'
  else
    Result := 'released ' + ShowDate(ReleasedAt) + ' (build ' + Copy(Commit, 1, 7) + ')';
end;

{ Installs from before the menu existed carry no ReleasedAt and count as older. }
function InstalledIsNewer: Boolean;
begin
  Result := (InstalledReleasedAt <> '') and (CompareStr(InstalledReleasedAt, ThisReleasedAt) > 0);
end;

procedure AddRollback(Path, Caption: String);
var
  Count: Integer;
begin
  Count := GetArrayLength(RollbackFiles);
  SetArrayLength(RollbackFiles, Count + 1);
  RollbackFiles[Count] := Path;
  RollbackPage.Add(Caption);
end;

procedure FindRollbacks;
var
  Found: TFindRec;
  Commit, ReleasedAt: String;
begin
  SetArrayLength(RollbackFiles, 0);
  if FindFirst(ArchiveDir + '\qro-*-setup.exe', Found) then
  try
    repeat
      Commit := Copy(Found.Name, 5, 40);
      ReleasedAt := GetIniString(Commit, 'ReleasedAt', '', ArchiveIni);
      { Only builds older than the installed one, and never the one already installed. }
      if (Commit <> InstalledCommit) and (ReleasedAt <> '') and
         ((InstalledReleasedAt = '') or (CompareStr(ReleasedAt, InstalledReleasedAt) < 0)) then
        AddRollback(ArchiveDir + '\' + Found.Name,
          'Version ' + GetIniString(Commit, 'Version', '', ArchiveIni) + ', ' + Describe(Commit, ReleasedAt));
    until not FindNext(Found);
  finally
    FindClose(Found);
  end;
  { This installer itself is a rollback target when it is older than what is installed. }
  if InstalledIsNewer and not FileExists(ArchiveDir + '\qro-' + ThisCommit + '-setup.exe') then
    AddRollback('', 'Version {#AppVersion}, ' + Describe(ThisCommit, ThisReleasedAt) + ' (this installer)');
end;

procedure InitializeWizard;
var
  Ignored, InstallLabel: String;
begin
  Installed := RegQueryStringValue(HKLM, UninstallKey, 'UninstallString', Ignored);
  InstalledCommit := '';
  InstalledReleasedAt := '';
  if Installed then
  begin
    RegQueryStringValue(HKLM, 'Software\Quant Research Office', 'SourceCommit', InstalledCommit);
    RegQueryStringValue(HKLM, 'Software\Quant Research Office', 'ReleasedAt', InstalledReleasedAt);
  end;
  { A silent run (a rollback started from the menu) is always a plain install of its own version. }
  ShowMenu := Installed and not WizardSilent;

  ActionPage := CreateInputOptionPage(wpWelcome, 'Quant Research Office is already installed',
    'Installed: ' + Describe(InstalledCommit, InstalledReleasedAt) + '.' + #13#10 +
    'This installer: version {#AppVersion}, ' + Describe(ThisCommit, ThisReleasedAt) + '.',
    'What would you like to do? Your projects and settings are kept in every case.', True, False);
  if InstalledCommit = ThisCommit then
    InstallLabel := 'Reinstall this version (repairs the installed files)'
  else if InstalledIsNewer then
    InstallLabel := 'Update (not available: the installed version is newer than this installer)'
  else
    InstallLabel := 'Update to this version';
  ActionPage.Add(InstallLabel);
  ActionPage.Add('Roll back to an earlier version');
  ActionPage.Add('Uninstall Quant Research Office');

  RollbackPage := CreateInputOptionPage(ActionPage.ID, 'Roll back',
    'Choose the version to go back to.',
    'Versions this PC has installed before are listed. Make a backup in Settings > Data & recovery first: ' +
    'an older version may not open data saved by a newer one.', True, True);
  SetArrayLength(RollbackFiles, 0);
  if Installed then
    FindRollbacks;

  ActionPage.SelectedValueIndex := 0;
  if InstalledIsNewer then
  begin
    ActionPage.CheckListBox.ItemEnabled[0] := False;
    ActionPage.SelectedValueIndex := 1;
  end;
  if GetArrayLength(RollbackFiles) = 0 then
  begin
    ActionPage.CheckListBox.ItemCaption[1] := 'Roll back (no earlier version is kept on this PC yet)';
    ActionPage.CheckListBox.ItemEnabled[1] := False;
    if InstalledIsNewer then
      ActionPage.SelectedValueIndex := 2;
  end
  else
    RollbackPage.SelectedValueIndex := 0;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = ActionPage.ID then
    Result := not ShowMenu
  else if PageID = RollbackPage.ID then
    Result := (not ShowMenu) or (ActionPage.SelectedValueIndex <> 1);
end;

procedure FinishNow;
begin
  Finished := True;
  WizardForm.Close;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if Finished then
    Confirm := False;
end;

procedure RunUninstaller;
var
  Command: String;
  Code: Integer;
begin
  if not RegQueryStringValue(HKLM, UninstallKey, 'UninstallString', Command) then
  begin
    MsgBox('The uninstaller was not found. Use Settings > Apps > Installed apps instead.', mbError, MB_OK);
    Exit;
  end;
  { The uninstaller asks for confirmation itself; the menu closes once it is done. }
  Exec(RemoveQuotes(Command), '', '', SW_SHOW, ewWaitUntilTerminated, Code);
  FinishNow;
end;

function RunKeptInstaller(Path: String): Boolean;
var
  Commit: String;
  Code: Integer;
begin
  Result := False;
  Commit := Copy(ExtractFileName(Path), 5, 40);
  if not SameText(GetSHA256OfFile(Path), GetIniString(Commit, 'Sha256', '', ArchiveIni)) then
  begin
    MsgBox('The kept installer for that version has changed since it was saved, so it will not be run. ' +
      'Download that version again instead.', mbError, MB_OK);
    Exit;
  end;
  if not Exec(Path, '/SILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_SHOW, ewWaitUntilTerminated, Code) or (Code <> 0) then
    MsgBox('The rollback did not finish (code ' + IntToStr(Code) + '). The installed version may be unchanged.', mbError, MB_OK)
  else
    MsgBox('Rolled back. Open Quant Research Office from the Start menu.', mbInformation, MB_OK);
  Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Target: String;
begin
  Result := True;
  if not ShowMenu then
    Exit;
  if (CurPageID = ActionPage.ID) and (ActionPage.SelectedValueIndex = 2) then
  begin
    Result := False;
    RunUninstaller;
  end
  else if CurPageID = RollbackPage.ID then
  begin
    Target := RollbackFiles[RollbackPage.SelectedValueIndex];
    { An empty target is this installer: continue with the normal install of its own version. }
    if Target <> '' then
    begin
      Result := False;
      if RunKeptInstaller(Target) then
        FinishNow;
    end;
  end;
end;

{ Keep a copy of this installer so a later version can roll back to it; keep the newest few. }
procedure KeepThisInstaller;
var
  Kept: String;
  Found: TFindRec;
  Commit, Oldest, OldestAt, At: String;
  Count: Integer;
begin
  ForceDirectories(ArchiveDir);
  Kept := ArchiveDir + '\qro-' + ThisCommit + '-setup.exe';
  if not FileExists(Kept) then
    if not FileCopy(ExpandConstant('{srcexe}'), Kept, False) then
      Exit;
  SetIniString(ThisCommit, 'Version', '{#AppVersion}', ArchiveIni);
  SetIniString(ThisCommit, 'ReleasedAt', ThisReleasedAt, ArchiveIni);
  SetIniString(ThisCommit, 'Sha256', GetSHA256OfFile(Kept), ArchiveIni);
  repeat
    Count := 0;
    Oldest := '';
    OldestAt := '';
    if FindFirst(ArchiveDir + '\qro-*-setup.exe', Found) then
    try
      repeat
        Count := Count + 1;
        Commit := Copy(Found.Name, 5, 40);
        At := GetIniString(Commit, 'ReleasedAt', '', ArchiveIni);
        if (Oldest = '') or (CompareStr(At, OldestAt) < 0) then
        begin
          Oldest := Commit;
          OldestAt := At;
        end;
      until not FindNext(Found);
    finally
      FindClose(Found);
    end;
    if Count > KeepVersions then
    begin
      if not DeleteFile(ArchiveDir + '\qro-' + Oldest + '-setup.exe') then
        Exit;
      DeleteIniSection(Oldest, ArchiveIni);
    end;
  until Count <= KeepVersions;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    KeepThisInstaller;
end;
