#Requires -RunAsAdministrator
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch]$Apply,
    [switch]$PurgeData,
    [string]$InstallDirectory = (Join-Path $env:ProgramFiles 'FileStructureAuditor'),
    [string]$DataDirectory = (Join-Path $env:ProgramData 'FileStructureAuditor'),
    [string]$BackupDirectory,
    [string[]]$FirewallRuleDisplayNames = @(
        'File Structure Auditor HTTPS - Internal',
        'File Structure Auditor HTTP Redirect - Internal',
        'File Structure Auditor HTTPS 8443 - Gateway'
    ),
    [switch]$RemoveCertificate,
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$CertificateThumbprint
)

$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Run this script in 64-bit PowerShell.' }
if ($Apply -and -not $PurgeData) { throw 'Full removal requires both -Apply and -PurgeData.' }
if ($RemoveCertificate -and -not $CertificateThumbprint) { throw '-RemoveCertificate requires an exact thumbprint.' }

function Confirm-AuditorDirectory([string]$Path, [string]$Label) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not [string]::Equals([IO.Path]::GetFileName($full), 'FileStructureAuditor', [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must end with FileStructureAuditor: $full"
    }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "$Label must be a normal directory: $full"
        }
    }
    return $full
}

$InstallDirectory = Confirm-AuditorDirectory $InstallDirectory 'InstallDirectory'
$DataDirectory = Confirm-AuditorDirectory $DataDirectory 'DataDirectory'
$expectedExe = Join-Path $InstallDirectory 'Auditor.Api.exe'
$service = Get-CimInstance Win32_Service -Filter "Name='FileStructureAuditor'"
if ($service) {
    $exeMatch = [regex]::Match($service.PathName, '^\s*"(?<exe>[^\"]+\.exe)"')
    if (-not $exeMatch.Success -or
        -not [string]::Equals($exeMatch.Groups['exe'].Value, $expectedExe, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The FileStructureAuditor service executable is not $expectedExe. Inspect it manually."
    }
}

if ($BackupDirectory) {
    $BackupDirectory = [IO.Path]::GetFullPath($BackupDirectory).TrimEnd('\', '/')
    foreach ($source in @($InstallDirectory, $DataDirectory)) {
        if ($BackupDirectory.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($BackupDirectory, $source, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'BackupDirectory must be outside the installation and data directories.'
        }
    }
    if (Test-Path -LiteralPath $BackupDirectory) { throw 'BackupDirectory must not exist.' }
}

if ($RemoveCertificate) {
    $thumbprint = $CertificateThumbprint.ToUpperInvariant()
    $httpBindings = (& netsh http show sslcert | Out-String).ToUpperInvariant()
    if ($httpBindings.Contains($thumbprint)) { throw 'Certificate is still bound by HTTP.sys.' }
}

$rules = @()
foreach ($displayName in $FirewallRuleDisplayNames) {
    $rules += @(Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq $displayName })
}
$rules = @($rules | Sort-Object Name -Unique)

Write-Output "Server: $env:COMPUTERNAME"
Write-Output "Service: $(if ($service) { $service.State } else { 'absent' })"
Write-Output "Install: $InstallDirectory"
Write-Output "Data: $DataDirectory"
Write-Output "Firewall rules: $($rules.Count)"
Write-Output "Certificate: $(if ($RemoveCertificate) { $CertificateThumbprint } else { 'retained' })"
if (-not $Apply) {
    Write-Output 'Preview complete. Use -Apply -PurgeData to remove the service and its local data.'
    return
}

if (-not $PSCmdlet.ShouldProcess($env:COMPUTERNAME, 'Remove FileStructureAuditor service, files, data and selected firewall rules')) { return }

if ($BackupDirectory) {
    New-Item -ItemType Directory -Path $BackupDirectory -ErrorAction Stop | Out-Null
    & icacls.exe $BackupDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict backup directory ACL: $BackupDirectory" }
    $backupAcl = Get-Acl -LiteralPath $BackupDirectory
    foreach ($accessRule in $backupAcl.Access) {
        $sid = $accessRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($accessRule.IsInherited -or $sid -notin @('S-1-5-18', 'S-1-5-32-544')) {
            throw "Backup directory ACL contains an unexpected principal: $sid"
        }
    }
}

$wasRunning = $service -and $service.State -eq 'Running'
try {
    if ($service -and $service.State -ne 'Stopped') {
        Stop-Service -Name FileStructureAuditor -ErrorAction Stop
        (Get-Service -Name FileStructureAuditor).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
    }
    if ($BackupDirectory) {
        foreach ($source in @($InstallDirectory, $DataDirectory)) {
            if (Test-Path -LiteralPath $source) {
                $label = if ($source -eq $InstallDirectory) { 'install' } else { 'data' }
                & robocopy.exe $source (Join-Path $BackupDirectory $label) /E /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
                if ($LASTEXITCODE -ge 8) { throw "Backup copy failed for $source (robocopy exit $LASTEXITCODE)." }
            }
        }
        foreach ($item in @(Get-Item -LiteralPath $BackupDirectory) + @(Get-ChildItem -LiteralPath $BackupDirectory -Recurse -Force -ErrorAction Stop)) {
            $itemAcl = Get-Acl -LiteralPath $item.FullName
            foreach ($accessRule in $itemAcl.Access) {
                $sid = $accessRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
                if ($sid -notin @('S-1-5-18', 'S-1-5-32-544')) {
                    throw "Backup ACL contains an unexpected principal: $($item.FullName): $sid"
                }
            }
        }
    }
} catch {
    $failure = $_
    if ($wasRunning) {
        try {
            Start-Service -Name FileStructureAuditor -ErrorAction Stop
            (Get-Service -Name FileStructureAuditor).WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
        } catch {
            throw "Uninstall preparation failed, and the service could not be restarted: $failure; restart error: $_"
        }
    }
    throw $failure
}

if ($service) {
    & sc.exe delete FileStructureAuditor
    if ($LASTEXITCODE -ne 0) { throw "sc.exe delete failed: $LASTEXITCODE" }
    for ($attempt = 0; $attempt -lt 30 -and (Get-Service -Name FileStructureAuditor -ErrorAction SilentlyContinue); $attempt++) {
        Start-Sleep -Seconds 1
    }
    if (Get-Service -Name FileStructureAuditor -ErrorAction SilentlyContinue) {
        throw 'The service is still registered. Recheck open handles before removing files.'
    }
}

$running = @(Get-CimInstance Win32_Process -Filter "Name='Auditor.Api.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $expectedExe.ToLowerInvariant() })
if ($running.Count) { throw 'Auditor.Api.exe is still running from the installation directory.' }

foreach ($rule in $rules) { Remove-NetFirewallRule -Name $rule.Name -ErrorAction Stop }
foreach ($path in @($InstallDirectory, $DataDirectory)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }
}

if ($RemoveCertificate) {
    $certPath = "Cert:\LocalMachine\My\$thumbprint"
    if (Test-Path -LiteralPath $certPath) { Remove-Item -LiteralPath $certPath -Force -ErrorAction Stop }
}

if ((Get-Service -Name FileStructureAuditor -ErrorAction SilentlyContinue) -or
    (Test-Path -LiteralPath $InstallDirectory) -or
    (Test-Path -LiteralPath $DataDirectory) -or
    @($rules | Where-Object { Get-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue }).Count) {
    throw 'Local removal is incomplete. Inspect the remaining items.'
}
Write-Output 'Local Auditor removal complete.'
