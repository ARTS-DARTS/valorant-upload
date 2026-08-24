param([string]$Server = 'root@212.15.49.68')

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$sha = (git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') { throw 'Failed to resolve control-plane SHA.' }
if (git -C $repoRoot status --porcelain --untracked-files=no) { throw 'Tracked files must be committed before installing the deployer.' }

$installId = [guid]::NewGuid().ToString('N')
$tempRoot = Join-Path $env:TEMP "valorant-upload-deployer-$installId"
$package = Join-Path $tempRoot 'control-plane.tar'
$remoteDeployer = "/var/lib/valorant-upload-deploy/incoming/deployer-$sha-$installId.sh"
$remoteInstaller = "/var/lib/valorant-upload-deploy/incoming/deployer-installer-$sha-$installId.sh"

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  git -C $repoRoot archive --format=tar -o $package $sha ops/deploy-valorant-upload.sh ops/install-valorant-upload-deployer.sh
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $package)) { throw 'Failed to archive committed control-plane files.' }
  tar -xf $package -C $tempRoot
  if ($LASTEXITCODE -ne 0) { throw 'Failed to extract committed control-plane files.' }

  $deployer = Join-Path $tempRoot 'ops\deploy-valorant-upload.sh'
  $installer = Join-Path $tempRoot 'ops\install-valorant-upload-deployer.sh'
  $deployerSha256 = (Get-FileHash -LiteralPath $deployer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($deployerSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Failed to checksum committed deployer.' }

  ssh $Server 'install -d -m 750 /var/lib/valorant-upload-deploy/incoming'
  if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare VPS incoming directory.' }
  scp $deployer "${Server}:$remoteDeployer"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to upload committed deployer.' }
  scp $installer "${Server}:$remoteInstaller"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to upload committed deployer installer.' }

  ssh $Server "bash '$remoteInstaller' '$remoteDeployer' '$deployerSha256'"
  if ($LASTEXITCODE -ne 0) { throw 'Protected VPS deployer installation failed.' }
}
finally {
  ssh $Server "rm -f -- '$remoteDeployer' '$remoteInstaller'" 2>$null | Out-Null
  $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
  $resolvedBase = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  if ($resolvedTemp.StartsWith($resolvedBase, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolvedTemp) -like 'valorant-upload-deployer-*') {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
