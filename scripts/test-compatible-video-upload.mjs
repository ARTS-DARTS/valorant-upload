import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('lineup uploads always return a broadly decodable video derivative', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const uploaderStart = source.indexOf('function uploadCompatibleLineupVideo');
  const wrapperStart = source.indexOf('function uploadVideoToSelectel');
  const uploader = source.slice(uploaderStart, wrapperStart);
  const wrapper = source.slice(wrapperStart, wrapperStart + 500);

  assert.match(uploader, /c_limit,h_1080,w_1920/);
  assert.match(uploader, /f_mp4,vc_h264:high:4\.2,ac_aac,fps_60,fl_progressive,q_auto:good/);
  assert.match(wrapper, /return uploadCompatibleLineupVideo\(file, onProgress\)/);
});
