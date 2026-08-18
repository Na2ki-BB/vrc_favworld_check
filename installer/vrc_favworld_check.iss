#ifndef AppVersion
  #error AppVersion must be supplied by scripts/build-installer.mjs
#endif

#define AppName "VRC Favorite World History"
#define AppId "Na2kiBB.VRCFavoriteWorldHistory.Chrome"
#define AppRoot "{localappdata}\Programs\VRCFavoriteWorldHistory"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Na2ki-BB
AppPublisherURL=https://github.com/Na2ki-BB/vrc_favworld_check
AppSupportURL=https://github.com/Na2ki-BB/vrc_favworld_check/issues
SetupMutex=Na2kiBB.VRCFavoriteWorldHistory.Chrome.Setup
DefaultDirName={#AppRoot}
DisableDirPage=yes
UsePreviousAppDir=no
PrivilegesRequired=lowest
CreateUninstallRegKey=yes
Uninstallable=yes
UninstallDisplayName={#AppName}
CloseApplications=no
RestartApplications=no
ChangesAssociations=no
ChangesEnvironment=no
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableReadyPage=no
DisableFinishedPage=no
DirExistsWarning=no
UsePreviousLanguage=no
MinVersion=10.0
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
OutputDir=..\artifacts
OutputBaseFilename=vrc_favworld_check-installer-v{#AppVersion}
VersionInfoDescription={#AppName} installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoVersion={#AppVersion}.0

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[InstallDelete]
Type: filesandordirs; Name: "{app}\extension.new"

[Files]
Source: "..\dist\extension\*"; DestDir: "{app}\extension.new"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "{code:GetChromeExecutable}"; Parameters: "--new-window ""chrome://extensions/"""; Description: "Chrome の拡張機能管理画面を開く"; Flags: postinstall nowait skipifsilent shellexec; Check: ShouldRunFirstInstallActions
Filename: "{app}\extension"; Description: "選択する extension フォルダーをエクスプローラーで開く"; Flags: postinstall nowait skipifsilent shellexec; Check: ShouldRunFirstInstallActions

[UninstallDelete]
Type: filesandordirs; Name: "{app}\extension"
Type: filesandordirs; Name: "{app}\extension.new"
Type: filesandordirs; Name: "{app}\extension.old"
Type: dirifempty; Name: "{app}"

[Code]
var
  ExistingInstallDetected: Boolean;
  FreshInstall: Boolean;
  OldExtensionCreated: Boolean;
  SwapCompleted: Boolean;

function FixedInstallDirectory: String;
begin
  Result := ExpandConstant('{#AppRoot}');
end;

function CurrentExtensionDirectory: String;
begin
  Result := FixedInstallDirectory + '\extension';
end;

function StagedExtensionDirectory: String;
begin
  Result := FixedInstallDirectory + '\extension.new';
end;

function OldExtensionDirectory: String;
begin
  Result := FixedInstallDirectory + '\extension.old';
end;

function IsDecimalComponent(const Value: String; var Number: Integer): Boolean;
var
  Index: Integer;
begin
  Result := False;
  Number := -1;
  if (Length(Value) = 0) or (Length(Value) > 5) then
    exit;

  for Index := 1 to Length(Value) do
  begin
    if (Value[Index] < '0') or (Value[Index] > '9') then
      exit;
  end;

  Number := StrToIntDef(Value, -1);
  Result := (Number >= 0) and (Number <= 65535);
end;

function TryParseSemVersion(const Value: String; var Major, Minor, Patch: Integer): Boolean;
var
  FirstDot: Integer;
  SecondDot: Integer;
  Remainder: String;
begin
  Result := False;
  FirstDot := Pos('.', Value);
  if FirstDot <= 1 then
    exit;

  Remainder := Copy(Value, FirstDot + 1, Length(Value));
  SecondDot := Pos('.', Remainder);
  if (SecondDot <= 1) or (Pos('.', Copy(Remainder, SecondDot + 1, Length(Remainder))) > 0) then
    exit;

  Result :=
    IsDecimalComponent(Copy(Value, 1, FirstDot - 1), Major) and
    IsDecimalComponent(Copy(Remainder, 1, SecondDot - 1), Minor) and
    IsDecimalComponent(Copy(Remainder, SecondDot + 1, Length(Remainder)), Patch);
end;

function CompareSemVersions(const LeftValue, RightValue: String; var Valid: Boolean): Integer;
var
  LeftMajor: Integer;
  LeftMinor: Integer;
  LeftPatch: Integer;
  RightMajor: Integer;
  RightMinor: Integer;
  RightPatch: Integer;
begin
  Result := 0;
  Valid :=
    TryParseSemVersion(LeftValue, LeftMajor, LeftMinor, LeftPatch) and
    TryParseSemVersion(RightValue, RightMajor, RightMinor, RightPatch);
  if not Valid then
    exit;

  if LeftMajor <> RightMajor then
    Result := LeftMajor - RightMajor
  else if LeftMinor <> RightMinor then
    Result := LeftMinor - RightMinor
  else
    Result := LeftPatch - RightPatch;
end;

function TryReadManifestVersion(const ManifestPath: String; var Version: String): Boolean;
var
  Lines: TArrayOfString;
  Index: Integer;
  KeyPosition: Integer;
  ColonPosition: Integer;
  FirstQuote: Integer;
  SecondQuote: Integer;
  Tail: String;
  Major: Integer;
  Minor: Integer;
  Patch: Integer;
begin
  Result := False;
  Version := '';
  if not LoadStringsFromFile(ManifestPath, Lines) then
    exit;

  for Index := 0 to GetArrayLength(Lines) - 1 do
  begin
    KeyPosition := Pos('"version"', Lines[Index]);
    if KeyPosition > 0 then
    begin
      Tail := Copy(Lines[Index], KeyPosition + Length('"version"'), Length(Lines[Index]));
      ColonPosition := Pos(':', Tail);
      if ColonPosition = 0 then
        exit;
      Tail := Copy(Tail, ColonPosition + 1, Length(Tail));
      FirstQuote := Pos('"', Tail);
      if FirstQuote = 0 then
        exit;
      Tail := Copy(Tail, FirstQuote + 1, Length(Tail));
      SecondQuote := Pos('"', Tail);
      if SecondQuote = 0 then
        exit;
      Version := Copy(Tail, 1, SecondQuote - 1);
      Result := TryParseSemVersion(Version, Major, Minor, Patch);
      exit;
    end;
  end;
end;

function TryGetInstalledVersion(var Version, ErrorMessage: String): Boolean;
var
  ManifestPath: String;
begin
  Result := False;
  Version := '';
  ErrorMessage := '';

  if FileExists(CurrentExtensionDirectory) or FileExists(OldExtensionDirectory) then
  begin
    ErrorMessage := '固定インストール先に、拡張フォルダーと同名のファイルがあります。' + #13#10 +
      '安全のためインストールを中止します。';
    exit;
  end;

  if DirExists(CurrentExtensionDirectory) then
    ManifestPath := CurrentExtensionDirectory + '\manifest.json'
  else if DirExists(OldExtensionDirectory) then
    ManifestPath := OldExtensionDirectory + '\manifest.json'
  else
  begin
    Result := True;
    exit;
  end;

  if not TryReadManifestVersion(ManifestPath, Version) then
  begin
    ErrorMessage := '現在の拡張機能のバージョンを確認できません。' + #13#10 +
      '既存ファイルを上書きせず、インストールを中止します。';
    exit;
  end;

  Result := True;
end;

function ValidateExistingState(var ErrorMessage: String): Boolean;
var
  InstalledVersion: String;
  ComparisonValid: Boolean;
begin
  Result := TryGetInstalledVersion(InstalledVersion, ErrorMessage);
  if not Result then
    exit;

  if InstalledVersion = '' then
    exit;

  if CompareSemVersions(InstalledVersion, '{#AppVersion}', ComparisonValid) > 0 then
  begin
    ErrorMessage := '新しい版 ' + InstalledVersion + ' が既にインストールされています。' + #13#10 +
      '古い版 {#AppVersion} へのダウングレードはできません。';
    Result := False;
  end
  else if not ComparisonValid then
  begin
    ErrorMessage := '拡張機能のバージョン形式を確認できません。';
    Result := False;
  end;
end;

function DeleteTreeWithRetries(const Directory: String): Boolean;
var
  Attempt: Integer;
begin
  Result := not DirExists(Directory);
  for Attempt := 1 to 3 do
  begin
    if Result then
      exit;
    Result := DelTree(Directory, True, True, True);
    if not Result then
      Sleep(250);
  end;
end;

procedure NormalizePreviousAttempt;
begin
  if (not DirExists(CurrentExtensionDirectory)) and DirExists(OldExtensionDirectory) then
  begin
    if not RenameFile(OldExtensionDirectory, CurrentExtensionDirectory) then
      RaiseException('前回の拡張ファイルを元に戻せませんでした。');
    Log('Recovered extension.old before installation.');
  end
  else if DirExists(CurrentExtensionDirectory) and DirExists(OldExtensionDirectory) then
  begin
    if not DeleteTreeWithRetries(OldExtensionDirectory) then
      RaiseException('前回の一時退避フォルダーを削除できませんでした。Chromeを閉じて再実行してください。');
    Log('Removed stale extension.old before installation.');
  end;
end;

function ValidateStagedExtension(const Directory: String; var ErrorMessage: String): Boolean;
var
  StagedVersion: String;
begin
  Result := False;
  ErrorMessage := '';
  if not TryReadManifestVersion(Directory + '\manifest.json', StagedVersion) then
    ErrorMessage := '新版の manifest.json を確認できませんでした。'
  else if CompareText(StagedVersion, '{#AppVersion}') <> 0 then
    ErrorMessage := '新版のバージョンがインストーラーと一致しません。'
  else if not FileExists(Directory + '\background.js') then
    ErrorMessage := '新版の background.js がありません。'
  else if not FileExists(Directory + '\dashboard.html') then
    ErrorMessage := '新版の dashboard.html がありません。'
  else if not FileExists(Directory + '\icons\icon128.png') then
    ErrorMessage := '新版の icon128.png がありません。'
  else
    Result := True;
end;

function RestoreOldExtension: Boolean;
begin
  Result := True;
  if DirExists(CurrentExtensionDirectory) then
  begin
    if not DeleteTreeWithRetries(CurrentExtensionDirectory) then
    begin
      Result := False;
      exit;
    end;
  end;

  if OldExtensionCreated then
  begin
    if DirExists(OldExtensionDirectory) then
      Result := RenameFile(OldExtensionDirectory, CurrentExtensionDirectory)
    else
      Result := False;
  end;

  if Result then
    OldExtensionCreated := False;
end;

procedure SwapStagedExtension;
var
  ErrorMessage: String;
begin
  if not ValidateStagedExtension(StagedExtensionDirectory, ErrorMessage) then
    RaiseException(ErrorMessage);

  OldExtensionCreated := False;
  if DirExists(CurrentExtensionDirectory) then
  begin
    if DirExists(OldExtensionDirectory) then
      RaiseException('一時退避フォルダーが残っているため更新できません。');
    if not RenameFile(CurrentExtensionDirectory, OldExtensionDirectory) then
      RaiseException('現在の拡張機能を一時退避できません。Chromeを閉じて再実行してください。');
    OldExtensionCreated := True;
  end;

  if not RenameFile(StagedExtensionDirectory, CurrentExtensionDirectory) then
  begin
    if not RestoreOldExtension then
      RaiseException('新版の配置と旧版の復元に失敗しました。固定フォルダーを変更せず、開発者へ連絡してください。');
    RaiseException('新版を配置できなかったため、旧版へ戻しました。');
  end;

  if not ValidateStagedExtension(CurrentExtensionDirectory, ErrorMessage) then
  begin
    if not RestoreOldExtension then
      RaiseException('新版の検証と旧版の復元に失敗しました。固定フォルダーを変更せず、開発者へ連絡してください。');
    RaiseException(ErrorMessage + #13#10 + '旧版へ戻しました。');
  end;

  SwapCompleted := True;
  if OldExtensionCreated then
  begin
    if DeleteTreeWithRetries(OldExtensionDirectory) then
      OldExtensionCreated := False
    else
    begin
      Log('Could not completely remove extension.old after successful swap.');
      MsgBox(
        '新版の配置は完了しましたが、一時退避フォルダーを削除できませんでした。' + #13#10 +
        'Chromeを閉じたまま、同じインストーラーをもう一度実行してください。',
        mbError,
        MB_OK
      );
    end;
  end;
end;

function GetChromeExecutable(Param: String): String;
var
  Candidate: String;
  ProgramDirectory: String;
begin
  Candidate := ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe');
  if FileExists(Candidate) then
  begin
    Result := Candidate;
    exit;
  end;

  ProgramDirectory := GetEnv('ProgramW6432');
  if ProgramDirectory <> '' then
  begin
    Candidate := AddBackslash(ProgramDirectory) + 'Google\Chrome\Application\chrome.exe';
    if FileExists(Candidate) then
    begin
      Result := Candidate;
      exit;
    end;
  end;

  ProgramDirectory := GetEnv('ProgramFiles');
  if ProgramDirectory <> '' then
  begin
    Candidate := AddBackslash(ProgramDirectory) + 'Google\Chrome\Application\chrome.exe';
    if FileExists(Candidate) then
    begin
      Result := Candidate;
      exit;
    end;
  end;

  ProgramDirectory := GetEnv('ProgramFiles(x86)');
  if ProgramDirectory <> '' then
  begin
    Candidate := AddBackslash(ProgramDirectory) + 'Google\Chrome\Application\chrome.exe';
    if FileExists(Candidate) then
    begin
      Result := Candidate;
      exit;
    end;
  end;

  Result := 'chrome.exe';
end;

function LaunchChromeExtensions: Boolean;
var
  ErrorCode: Integer;
begin
  Result := ShellExec(
    'open',
    GetChromeExecutable(''),
    '--new-window "chrome://extensions/"',
    '',
    SW_SHOWNORMAL,
    ewNoWait,
    ErrorCode
  );
  if not Result then
    MsgBox('Chromeを自動で開けませんでした。Chromeで chrome://extensions/ を開いてください。', mbError, MB_OK);
end;

function InitializeSetup: Boolean;
var
  ErrorMessage: String;
begin
  ExistingInstallDetected :=
    DirExists(CurrentExtensionDirectory) or DirExists(OldExtensionDirectory);
  FreshInstall := not ExistingInstallDetected;
  Result := ValidateExistingState(ErrorMessage);
  if not Result then
    MsgBox(ErrorMessage, mbError, MB_OK);
end;

procedure InitializeWizard;
var
  GuidePage: TOutputMsgMemoWizardPage;
begin
  WizardForm.DirEdit.Text := FixedInstallDirectory;

  if FreshInstall then
  begin
    GuidePage := CreateOutputMsgMemoPage(
      wpWelcome,
      'Chromeへの追加手順',
      'インストール完了後に2つの画面を開きます',
      '次の順番で拡張機能をChromeへ追加してください。',
      '1. Chromeの拡張機能画面で「デベロッパー モード」をオンにします。' + #13#10 +
      '2. 「パッケージ化されていない拡張機能を読み込む」を押します。' + #13#10 +
      '3. エクスプローラーで開いた extension フォルダーを選択します。' + #13#10 + #13#10 +
      'インストール完了後、Downloads内のこのインストーラーは削除できます。'
    );
    GuidePage.RichEditViewer.ReadOnly := True;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpReady) and ExistingInstallDetected then
  begin
    Result := MsgBox(
      '更新前に、Google Chromeのウィンドウをすべて閉じてください。' + #13#10 +
      'インストーラーはChromeを強制終了しません。' + #13#10 + #13#10 +
      'Chromeをすべて閉じましたか？',
      mbConfirmation,
      MB_YESNO
    ) = IDYES;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  NeedsRestart := False;
  Result := '';
  if CompareText(WizardDirValue, FixedInstallDirectory) <> 0 then
  begin
    Result := 'インストール先は変更できません。セットアップを閉じて、通常どおり再実行してください。';
    exit;
  end;

  if not ValidateExistingState(Result) then
    exit;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    if CompareText(ExpandConstant('{app}'), FixedInstallDirectory) <> 0 then
      RaiseException('固定インストール先を確認できません。');
    NormalizePreviousAttempt;
  end
  else if CurStep = ssPostInstall then
    SwapStagedExtension;
end;

procedure DeinitializeSetup;
begin
  if OldExtensionCreated and (not SwapCompleted) then
  begin
    if RestoreOldExtension then
      Log('Restored extension.old while setup was terminating after a failure.')
    else
      Log('Failed to restore extension.old while setup was terminating.');
  end;
end;

function ShouldRunFirstInstallActions: Boolean;
begin
  Result := FreshInstall and SwapCompleted;
end;

function InitializeUninstall: Boolean;
begin
  Result := MsgBox(
    '先にChromeの拡張機能「VRC Favorite World History」を開き、' + #13#10 +
    '必要なら「バックアップを書き出す」を実行してから、' + #13#10 +
    '「記録をすべて削除してアンインストール」を完了してください。' + #13#10 + #13#10 +
    'Windows側のアンインストーラーは、Chromeのprofile、Cookie、IndexedDB、' + #13#10 +
    '書き出したJSONバックアップを削除しません。' + #13#10 + #13#10 +
    'Chrome側の操作は完了しましたか？',
    mbConfirmation,
    MB_YESNO
  ) = IDYES;

  if not Result then
  begin
    LaunchChromeExtensions;
    MsgBox(
      'Chrome側の操作を完了してから、Windowsのアンインストールをもう一度実行してください。',
      mbInformation,
      MB_OK
    );
  end;
end;
