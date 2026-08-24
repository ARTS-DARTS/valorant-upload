param([string]$Server = 'root@212.15.49.68')

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$sha = (git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') { throw 'Failed to resolve release SHA.' }
if (git -C $repoRoot status --porcelain --untracked-files=no) { throw 'Tracked files must be committed before deployment.' }

$archive = Join-Path $env:TEMP "valorant-upload-$sha.tar"
$deployScript = Join-Path $env:TEMP "deploy-valorant-upload-$sha.sh"
try {
  git -C $repoRoot archive --format=tar -o $archive $sha
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archive)) { throw 'Failed to create release archive.' }

  ssh $Server 'install -d -m 750 /var/lib/valorant-upload-deploy/incoming'
  if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare VPS incoming directory.' }
  $remoteArchive = "/var/lib/valorant-upload-deploy/incoming/$sha.tar"
  scp $archive "${Server}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to upload release archive.' }
  $scriptText = [IO.File]::ReadAllText((Join-Path $repoRoot 'ops/deploy-valorant-upload.sh')).Replace("`r`n", "`n")
  [IO.File]::WriteAllText($deployScript, $scriptText, [Text.UTF8Encoding]::new($false))
  scp $deployScript "${Server}:/tmp/deploy-valorant-upload.sh"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to upload deployment script.' }

  ssh $Server "bash -n /tmp/deploy-valorant-upload.sh && install -o root -g root -m 750 /tmp/deploy-valorant-upload.sh /usr/local/bin/deploy-valorant-upload.sh && VALORANT_UPLOAD_SOURCE_ARCHIVE='$remoteArchive' VALORANT_UPLOAD_SOURCE_SHA='$sha' /usr/local/bin/deploy-valorant-upload.sh"
  if ($LASTEXITCODE -ne 0) { throw 'Safe VPS deployment failed. Check /var/log/valorant-upload-deploy.log.' }

  $ready = Invoke-RestMethod -Uri "https://vlineups.ru/ready?v=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers @{ 'Cache-Control' = 'no-cache' }
  if ($ready.ok -ne $true -or $ready.sha -ne $sha) { throw 'Live readiness does not match the deployed release.' }
  Write-Host "VALORANT_UPLOAD_VPS_DEPLOYED=$sha"
}
finally {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $deployScript -Force -ErrorAction SilentlyContinue
}
