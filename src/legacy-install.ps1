param(
  [Parameter(Mandatory=$true)][ValidateSet('CopyProfile','BeforeInstallCleanup')][string]$Action,
  [string]$Source,
  [string]$Stage,
  [int]$ParentId
)
$ErrorActionPreference = 'Stop'

function Assert-AppsClosed([int]$ExceptId = 0) {
  $busy = @(Get-Process | Where-Object {
    $_.Id -ne $ExceptId -and $_.ProcessName -in @('Folia', 'Markaloo')
  })
  if ($busy.Count -ne 0) { throw 'Close Folia and other Markaloo instances, then retry.' }
}

function Assert-RegularPath([string]$Path, [bool]$Directory) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.PSIsContainer -ne $Directory) {
    throw 'A profile path is redirected or has an unexpected type.'
  }
}

function Assert-CleanupAllowed([bool]$Elevated, [bool]$CurrentUser,
    [string]$Directory, [string[]]$Profiles) {
  if ($Elevated -and $CurrentUser) {
    throw 'Per-user Folia removal is skipped while setup runs as administrator.'
  }
  if (-not $Elevated -and -not $CurrentUser) {
    throw 'Removing the old all-users installation requires an already elevated setup.'
  }
  if (-not [IO.Path]::IsPathRooted($Directory) -or $Profiles.Count -eq 0) {
    throw 'The installation or retained profile paths are unavailable.'
  }
  $installation = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
  foreach ($profile in $Profiles) {
    if (-not [IO.Path]::IsPathRooted($profile)) {
      throw 'The installation or retained profile paths are unavailable.'
    }
    $retained = [IO.Path]::GetFullPath($profile).TrimEnd('\') + '\'
    # Stock removes the installation directory recursively, even when keeping app data.
    if ($installation.StartsWith($retained, [StringComparison]::OrdinalIgnoreCase) -or
        $retained.StartsWith($installation, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'The old installation overlaps retained profile data.'
    }
  }
}

function Remove-LegacyInstall {
  # Called only by setup's pre-write hook, never by the installed app.
  Assert-AppsClosed
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } finally { $identity.Dispose() }
  $appData = [Environment]::GetFolderPath('ApplicationData')
  if (-not [IO.Path]::IsPathRooted($appData)) {
    throw 'The retained profile location is unavailable.'
  }
  $profilePaths = @('Folia', 'Markaloo', 'Folia-dev', 'Markaloo-dev') |
    ForEach-Object { Join-Path $appData $_ }
  $guid = '243b513d-dcaf-54c6-b3f2-3d91dcfd5689'
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,
                      [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,
                        [Microsoft.Win32.RegistryView]::Registry32)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      $key = $null
      $install = $null
      try {
        $key = $base.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
        if ($null -eq $key) { continue }
        $install = $base.OpenSubKey("Software\$guid")
        if ($null -eq $install) { throw 'The old installation location is unavailable.' }
        $directory = [string]$install.GetValue('InstallLocation', '')
        $registered = [string]$key.GetValue('UninstallString', '')
        if ($registered -notmatch '^"([^"]+\.exe)"\s+(/currentuser|/allusers)\s*$') {
          throw 'The registered Folia uninstaller is not a recognized electron-builder command.'
        }
        $uninstaller = $Matches[1]
        $scope = $Matches[2]
        if (($hive -eq [Microsoft.Win32.RegistryHive]::CurrentUser -and $scope -ine '/currentuser') -or
            ($hive -eq [Microsoft.Win32.RegistryHive]::LocalMachine -and $scope -ine '/allusers')) {
          throw 'The old installation scope is inconsistent.'
        }
        if (-not [IO.Path]::IsPathRooted($directory) -or
            -not [IO.Path]::IsPathRooted($uninstaller)) {
          throw 'The old installation paths are not absolute.'
        }
        Assert-CleanupAllowed $elevated ($hive -eq [Microsoft.Win32.RegistryHive]::CurrentUser) $directory $profilePaths
        $old = [IO.Path]::GetFullPath($directory).TrimEnd('\') + '\'
        $uninstallerDirectory = [IO.Path]::GetDirectoryName(
          [IO.Path]::GetFullPath($uninstaller)).TrimEnd('\') + '\'
        if ($uninstallerDirectory -ine $old) {
          throw 'The registered uninstaller is outside the old installation directory.'
        }
        Assert-RegularPath $directory $true
        Assert-RegularPath $uninstaller $false
        $temporary = Join-Path $PSScriptRoot "folia-$hive-$view-uninstaller.exe"
        [IO.File]::Copy($uninstaller, $temporary, $false)
        Assert-AppsClosed
        # Stock copies the uninstaller and uses final _?= to wait for its real work.
        $result = Start-Process -FilePath $temporary `
          -ArgumentList "/S $scope --updated /KEEP_APP_DATA _?=$directory" -Wait -PassThru
        if ($result.ExitCode -ne 0) { throw "Folia uninstall returned $($result.ExitCode)." }
      } finally {
        if ($null -ne $install) { $install.Dispose() }
        if ($null -ne $key) { $key.Dispose() }
        $base.Dispose()
      }
    }
  }
}

try {
  if ($Action -eq 'CopyProfile') {
    Assert-RegularPath $Source $true
    Assert-RegularPath $Stage $true
    Assert-AppsClosed $ParentId
    $database = Join-Path $Source 'Local Storage\leveldb'
    $lock = $null
    try {
      if (Test-Path -LiteralPath $database) {
        Assert-RegularPath (Join-Path $Source 'Local Storage') $true
        Assert-RegularPath $database $true
        $lockPath = Join-Path $database 'LOCK'
        Assert-RegularPath $lockPath $false
        # Open, never create or change Folia's LOCK. FileShare.None rejects a
        # live LevelDB handle and prevents one opening during the copy.
        $lock = [IO.File]::Open($lockPath, [IO.FileMode]::Open,
          [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      }
      Assert-AppsClosed $ParentId
      foreach ($name in @('window-state.json', 'document-session.json', 'document-session-import.json')) {
        $file = Join-Path $Source $name
        if (Test-Path -LiteralPath $file) {
          Assert-RegularPath $file $false
          [IO.File]::Copy($file, (Join-Path $Stage $name), $false)
        }
      }
      if ($null -ne $lock) {
        $destination = Join-Path $Stage 'Local Storage\leveldb'
        [IO.Directory]::CreateDirectory($destination) | Out-Null
        foreach ($file in Get-ChildItem -LiteralPath $database -Force) {
          if ($file.Name -cmatch '^(CURRENT|MANIFEST-\d+|\d+\.(log|ldb|sst))$') {
            Assert-RegularPath $file.FullName $false
            [IO.File]::Copy($file.FullName, (Join-Path $destination $file.Name), $false)
          }
        }
      }
    } finally {
      if ($null -ne $lock) { $lock.Dispose() }
    }
  } else {
    Remove-LegacyInstall
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
