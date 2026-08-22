import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const js = await readFile(new URL('app.js', root), 'utf8');

function functionBody(name, nextMarker) {
  const start = js.indexOf(`function ${name}(`);
  const end = js.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `${name} must exist`);
  return js.slice(start, end);
}

test('Sage wall options render without unrelated free variables', () => {
  const body = functionBody('renderSageWallOptions', "\n}\n\ndocument.getElementById('sage-wall-handles-toggle')");
  assert.doesNotMatch(body, /\babilityName\b/);
  assert.match(body, /selectedSageWallItem\(\)/);
  assert.match(body, /sageWallHandlesHidden/);
});

test('removing a defense ability immediately updates panel, map and validation', () => {
  const start = js.indexOf("list.querySelectorAll('[data-remove-defense-ability]')");
  const end = js.indexOf("list.querySelectorAll('[data-resize-defense-ability]')", start);
  assert.ok(start >= 0 && end > start, 'defense removal handler must exist');
  const handler = js.slice(start, end);
  assert.match(handler, /defenseAbilities\.splice\(removed, 1\)/);
  assert.match(handler, /renderDefenseAbilityPanel\(\)/);
  assert.match(handler, /renderDefenseAbilityMarkers\(\)/);
  assert.match(handler, /validateForm\(\); _saveDraft\(\)/);
});

test('defense submission serializes the current ability array', () => {
  const body = functionBody('defenseSubmissionPayload', 'const configuredDefenseShapeCache');
  assert.match(body, /abilities:serializedDefenseAbilities\(\)/);
  assert.match(js, /contentType === 'defense' \? defenseSubmissionPayload\(\) : \{\}/);
});
