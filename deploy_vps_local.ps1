param(
  [string]$Server = 'root@212.15.49.68',
  [switch]$AllowRollback
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$sha = (git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') { throw 'Failed to resolve release SHA.' }
if (git -C $repoRoot status --porcelain --untracked-files=no) { throw 'Tracked files must be committed before deployment.' }

$readyBefore = Invoke-RestMethod -Uri "https://vlineups.ru/ready?v=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers @{ 'Cache-Control' = 'no-cache' }
$currentSha = [string]$readyBefore.sha
if ($readyBefore.ok -ne $true -or $currentSha -notmatch '^[0-9a-f]{40}$') { throw 'Cannot establish the current production SHA.' }
git -C $repoRoot cat-file -e "$currentSha`^{commit}"
if ($LASTEXITCODE -ne 0) { throw "Current production SHA $currentSha is not available in the local repository." }
if (-not $AllowRollback) {
  git -C $repoRoot merge-base --is-ancestor $currentSha $sha
  if ($LASTEXITCODE -ne 0) { throw "Refusing non-forward deployment from $currentSha to $sha. Use -AllowRollback only for an intentional rollback." }
}
$ancestryVerified = if ($AllowRollback) { '0' } else { '1' }

$archiveId = [guid]::NewGuid().ToString('N')
$archive = Join-Path $env:TEMP "valorant-upload-$sha-$archiveId.tar"
$remoteArchive = "/var/lib/valorant-upload-deploy/incoming/$sha-$archiveId.tar"
$serverDeployer = '/usr/local/sbin/valorant-upload-deployer'
try {
  git -C $repoRoot archive --format=tar "--add-virtual-file=.valorant-deploy-source-sha:$sha" -o $archive $sha
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archive)) { throw 'Failed to create release archive.' }
  $archiveSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($archiveSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Failed to checksum release archive.' }

  ssh $Server 'install -d -m 750 /var/lib/valorant-upload-deploy/incoming'
  if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare VPS incoming directory.' }
  scp $archive "${Server}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to upload release archive.' }

  $apiVersion = [string](ssh $Server "$serverDeployer --api-version")
  if ($LASTEXITCODE -ne 0 -or $apiVersion.Trim() -ne '3') {
    throw 'The protected VPS deployer is missing or incompatible. Run install_vps_deployer.ps1 first.'
  }

  $rollbackFlag = if ($AllowRollback) { '1' } else { '0' }
  ssh $Server "VALORANT_UPLOAD_SOURCE_ARCHIVE='$remoteArchive' VALORANT_UPLOAD_SOURCE_ARCHIVE_SHA256='$archiveSha256' VALORANT_UPLOAD_SOURCE_SHA='$sha' VALORANT_UPLOAD_EXPECTED_CURRENT_SHA='$currentSha' VALORANT_UPLOAD_ANCESTRY_VERIFIED='$ancestryVerified' VALORANT_UPLOAD_ALLOW_ROLLBACK='$rollbackFlag' VALORANT_UPLOAD_DEPLOY_INITIATOR='local-archive' $serverDeployer"
  if ($LASTEXITCODE -ne 0) { throw 'Safe VPS deployment failed. Check /var/log/valorant-upload-deploy.log.' }

  $ready = Invoke-RestMethod -Uri "https://vlineups.ru/ready?v=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers @{ 'Cache-Control' = 'no-cache' }
  if ($ready.ok -ne $true -or $ready.sha -ne $sha) { throw 'Live readiness does not match the deployed release.' }
  Write-Host "VALORANT_UPLOAD_VPS_DEPLOYED=$sha"
}
finally {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  ssh $Server "rm -f -- '$remoteArchive'" 2>$null | Out-Null
}
