import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || '';
}

async function main() {
  const input = path.resolve(argument('input'));
  const keyPath = path.resolve(argument('key'));
  const output = argument('output') ? path.resolve(argument('output')) : '';
  if (!argument('input') || !argument('key')) {
    throw new Error('Pass --input=SNAPSHOT and --key=KEY_FILE.');
  }
  const encrypted = await fs.readFile(input);
  const header = Buffer.from('VLMEDIA1\n');
  if (!encrypted.subarray(0, header.length).equals(header)) throw new Error('Unknown snapshot format.');
  const key = Buffer.from((await fs.readFile(keyPath, 'utf8')).trim(), 'base64');
  if (key.length !== 32) throw new Error('Invalid recovery key.');
  const ivStart = header.length;
  const iv = encrypted.subarray(ivStart, ivStart + 12);
  const tag = encrypted.subarray(ivStart + 12, ivStart + 28);
  const ciphertext = encrypted.subarray(ivStart + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  JSON.parse(plaintext.toString('utf8'));
  if (output) {
    await fs.writeFile(output, plaintext, { flag: 'wx' });
    console.log(`Verified and decrypted to ${output}`);
  } else {
    console.log(`Verified ${path.basename(input)} (${plaintext.length} decrypted bytes)`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
