import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const localDeploy = await readFile(new URL('deploy_vps_local.ps1', root), 'utf8');
const serverDeploy = await readFile(new URL('ops/deploy-valorant-upload.sh', root), 'utf8');
const deployerInstaller = await readFile(new URL('ops/install-valorant-upload-deployer.sh', root), 'utf8');
const localDeployerInstaller = await readFile(new URL('install_vps_deployer.ps1', root), 'utf8');
const serverDeployPath = fileURLToPath(new URL('ops/deploy-valorant-upload.sh', root));
const deployerInstallerPath = fileURLToPath(new URL('ops/install-valorant-upload-deployer.sh', root));

function tarOctal(header, offset, length, value) {
  const encoded = `${Number(value).toString(8).padStart(length - 1, '0')}\0`;
  header.write(encoded, offset, length, 'ascii');
}

function tarEntry({ name, type = '0', data = '', linkname = '' }) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  tarOctal(header, 100, 8, type === '5' ? 0o755 : 0o644);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, type === '0' || type === '\0' ? payload.length : 0);
  tarOctal(header, 136, 12, 1_700_000_000);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  return Buffer.concat([header, payload, padding]);
}

function createTar(entries) {
  return Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]);
}

function bashPath(path) {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

function resolveBash() {
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  const whereGit = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' });
  const gitRoot = whereGit.status === 0
    ? dirname(dirname(whereGit.stdout.split(/\r?\n/).find(Boolean) || ''))
    : '';
  const candidates = [
    process.env.VLINEUPS_BASH,
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    gitRoot && join(gitRoot, 'bin', 'bash.exe'),
  ].filter(Boolean);
  const resolved = candidates.find(existsSync);
  assert.ok(resolved, 'Git Bash is required for deploy control-plane tests on Windows');
  return resolved;
}

const bashExecutable = resolveBash();

test('control-plane shell scripts parse in the shell used by deployment', () => {
  for (const path of [serverDeployPath, deployerInstallerPath]) {
    const result = spawnSync(bashExecutable, ['-n', bashPath(path)], { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
  }
});

test('repository forces every shell script to LF in committed release archives', async () => {
  const attributes = await readFile(new URL('.gitattributes', root), 'utf8');
  assert.match(attributes, /^\*\.sh\s+text\s+eol=lf\s*$/m);
  for (const path of [serverDeployPath, deployerInstallerPath]) {
    const source = await readFile(path);
    assert.equal(source.includes(Buffer.from('\r\n')), false, `${path} still contains CRLF`);
  }
});

async function validateArchive(entries, expectedSha) {
  const temp = await mkdtemp(join(tmpdir(), 'valorant-archive-guard-'));
  const archive = join(temp, 'fixture.tar');
  await writeFile(archive, createTar(entries));
  const result = spawnSync(bashExecutable, [
    bashPath(serverDeployPath),
    '--validate-archive',
    bashPath(archive),
    expectedSha,
  ], { encoding: 'utf8' });
  await rm(temp, { recursive: true, force: true });
  if (result.error) throw result.error;
  return result;
}

test('local deploy refuses a non-forward candidate unless rollback is explicit', () => {
  assert.match(localDeploy, /merge-base --is-ancestor \$currentSha \$sha/);
  assert.match(localDeploy, /Use -AllowRollback only for an intentional rollback/);
  assert.match(localDeploy, /VALORANT_UPLOAD_EXPECTED_CURRENT_SHA='\$currentSha'/);
  assert.match(localDeploy, /VALORANT_UPLOAD_ANCESTRY_VERIFIED='\$ancestryVerified'/);
  assert.match(localDeploy, /--add-virtual-file=\.valorant-deploy-source-sha:\$sha/);
  assert.match(localDeploy, /VALORANT_UPLOAD_SOURCE_ARCHIVE_SHA256='\$archiveSha256'/);
});

test('runtime deploy uses only the protected stable control plane', () => {
  assert.match(localDeploy, /serverDeployer = '\/usr\/local\/sbin\/valorant-upload-deployer'/);
  assert.doesNotMatch(localDeploy, /install .*deploy-valorant-upload\.sh/);
  assert.doesNotMatch(localDeploy, /scp \$deployScript/);
  assert.match(serverDeploy, /explicit source archive and SHA are required/);
  assert.doesNotMatch(serverDeploy, /git fetch origin main/);
  assert.match(serverDeploy, /current SHA changed \(expected/);
  assert.match(serverDeploy, /forward ancestry was not verified by the archive builder/);
});

test('archive bytes and candidate identity are verified before preflight', () => {
  const checksumPosition = serverDeploy.indexOf('source archive checksum does not match');
  const markerPosition = serverDeploy.indexOf('archive source marker does not match candidate SHA');
  const installPosition = serverDeploy.indexOf('npm ci --omit=optional');
  assert.ok(checksumPosition >= 0);
  assert.ok(markerPosition >= 0);
  assert.ok(installPosition > markerPosition, 'archive identity must be checked before package code executes');
  assert.match(serverDeploy, /\.release-archive-sha256/);
  assert.doesNotMatch(serverDeploy, /tar[^\n]*\|[^\n]*grep/);
  assert.match(serverDeploy, /archive may contain only regular files and directories/);
  assert.match(serverDeploy, /archive must contain exactly one source marker/);
  assert.match(serverDeploy, /refusing deploy: shell script contains CRLF/);
  assert.ok(
    serverDeploy.indexOf('refusing deploy: shell script contains CRLF') < installPosition,
    'CRLF shell scripts must be rejected before package code executes',
  );
});

test('deployer updates are serialized, immutable, and cannot downgrade', () => {
  assert.match(deployerInstaller, /valorant-upload-deployer-install\.lock/);
  assert.match(deployerInstaller, /candidate_version < installed_version/);
  assert.match(deployerInstaller, /Refusing unversioned deployer replacement/);
  assert.match(deployerInstaller, /chattr \+i "\$STABLE_DEPLOYER" "\$LEGACY_ENTRYPOINT"/);
  assert.match(deployerInstaller, /Legacy VLineups deploy entrypoint is disabled/);
  assert.match(deployerInstaller, /transaction_started=1/);
  assert.match(deployerInstaller, /restore_path "\$STABLE_DEPLOYER"/);
  assert.match(deployerInstaller, /both previous entrypoints were restored and verified/);
  assert.match(deployerInstaller, /CRITICAL: deployer installer rollback/);
  assert.doesNotMatch(deployerInstaller, /candidate_version=\$\(bash/);
  assert.match(localDeployerInstaller, /\.Replace\("\`r\`n", "\`n"\)\.Replace\("\`r", "\`n"\)/);
  assert.match(localDeployerInstaller, /UTF8Encoding\]::new\(\$false\)/);
});

test('last-good changes only after preflight and before a different release is activated', () => {
  const ensurePosition = serverDeploy.indexOf('ensure_release "$release_dir"');
  const guardedPosition = serverDeploy.indexOf('if [[ "$remote_sha" != "$current_sha" ]]', ensurePosition);
  const lastGoodPosition = serverDeploy.indexOf('atomic_link "$current_target" "$LAST_GOOD_LINK"', guardedPosition);
  const activationPosition = serverDeploy.indexOf('log "activating release $remote_sha"');

  assert.ok(ensurePosition >= 0, 'candidate must pass isolated preflight');
  assert.ok(guardedPosition > ensurePosition, 'last-good update must be guarded by a different-SHA check');
  assert.ok(lastGoodPosition > guardedPosition, 'current runtime must become the rollback target');
  assert.ok(activationPosition > lastGoodPosition, 'rollback target must be recorded immediately before activation');
  assert.equal(serverDeploy.slice(0, ensurePosition).includes('atomic_link "$current_target" "$LAST_GOOD_LINK"'), false);
  assert.doesNotMatch(serverDeploy, /atomic_link "\$release_dir" "\$LAST_GOOD_LINK"/);
});

test('same-SHA fast path and rollback report only verified runtime state', () => {
  assert.match(serverDeploy, /if \[\[ "\$remote_sha" == "\$current_sha" \]\] && probe_ready_once/);
  assert.match(serverDeploy, /if ! start_runtime "\$rollback_target" "\$rollback_sha"/);
  assert.match(serverDeploy, /if ! probe_ready "\$rollback_sha"/);
  assert.match(serverDeploy, /CRITICAL: automatic rollback failed/);
});

test('archive validator accepts only a single exact marker plus regular files and directories', async () => {
  const sha = 'a'.repeat(40);
  const result = await validateArchive([
    { name: '.valorant-deploy-source-sha', data: sha },
    { name: 'assets/', type: '5' },
    { name: 'assets/app.js', data: 'console.log("ok")' },
  ], sha);
  assert.equal(result.status, 0, result.stderr);
});

test('archive validator rejects traversal even when the first match precedes a large listing', async () => {
  const sha = 'b'.repeat(40);
  const filler = Array.from({ length: 1500 }, (_, index) => ({
    name: `safe/file-${String(index).padStart(4, '0')}.txt`,
    data: 'x',
  }));
  for (const unsafeName of ['../escape', 'safe/../escape', '/absolute']) {
    const result = await validateArchive([
      { name: unsafeName, data: 'blocked' },
      { name: '.valorant-deploy-source-sha', data: sha },
      ...filler,
    ], sha);
    assert.notEqual(result.status, 0, `${unsafeName} unexpectedly passed`);
  }
});

test('archive validator rejects links and special entries before extraction', async () => {
  const sha = 'c'.repeat(40);
  for (const type of ['1', '2', '3', '4', '6', '7']) {
    const result = await validateArchive([
      { name: '.valorant-deploy-source-sha', data: sha },
      { name: `blocked-${type}`, type, linkname: '../outside' },
    ], sha);
    assert.notEqual(result.status, 0, `tar type ${type} unexpectedly passed`);
  }
});

test('archive validator rejects duplicate or inexact source markers', async () => {
  const sha = 'd'.repeat(40);
  const duplicate = await validateArchive([
    { name: '.valorant-deploy-source-sha', data: sha },
    { name: '.valorant-deploy-source-sha', data: sha },
  ], sha);
  assert.notEqual(duplicate.status, 0);
  const wrong = await validateArchive([
    { name: '.valorant-deploy-source-sha', data: `${sha}\n` },
  ], sha);
  assert.notEqual(wrong.status, 0);
});
