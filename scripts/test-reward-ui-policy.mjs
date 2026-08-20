import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canSubmitForRewards,
  rewardActionErrorMessage,
  rewardProgramAccepting,
} from '../reward-ui-policy.mjs';

test('reward actions require an explicitly enabled program', () => {
  assert.equal(rewardProgramAccepting({ enabled:true }), true);
  assert.equal(rewardProgramAccepting({ enabled:false }), false);
  assert.equal(rewardProgramAccepting({}), false);
});

test('submission opt-in requires program, membership and current terms', () => {
  const valid = { settings:{ enabled:true }, membership:{ status:'active', terms_current:true } };
  assert.equal(canSubmitForRewards(valid), true);
  assert.equal(canSubmitForRewards({ ...valid, settings:{ enabled:false } }), false);
  assert.equal(canSubmitForRewards({ ...valid, membership:{ status:'active', terms_current:false } }), false);
});

test('reward errors never expose a technical stack', () => {
  assert.equal(rewardActionErrorMessage({
    code:'functions/failed-precondition',
    message:'Rewards program is not accepting participants.\n#0 stack',
  }), 'Программа наград пока не принимает участников');
  assert.equal(rewardActionErrorMessage(new Error('Ошибка\n#0 stack')), 'Ошибка');
});
