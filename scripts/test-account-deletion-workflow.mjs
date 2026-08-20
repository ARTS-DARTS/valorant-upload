import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateDeletionRisk } from '../backend/account-deletion-workflow.js';

const now = new Date('2026-08-17T12:00:00Z');

test('verified recent deletion request stays below quarantine threshold', () => {
  const result = evaluateDeletionRisk({
    decoded:{ auth_time:Math.floor(now.getTime() / 1000) - 30, firebase:{ sign_in_provider:'password' } },
    userRecord:{ metadata:{ creationTime:'2025-01-01T00:00:00Z' } },
    appCheckVerified:true, now,
  });
  assert.deepEqual(result, { score:0, reasons:[], suspicious:false });
});

test('unverified repeated request is quarantined without relying on personal data', () => {
  const result = evaluateDeletionRisk({
    decoded:{ auth_time:Math.floor(now.getTime() / 1000) - 360, firebase:{ sign_in_provider:'password' } },
    userRecord:{ metadata:{ creationTime:'2025-01-01T00:00:00Z' } },
    appCheckVerified:false, priorRequests:1, now,
  });
  assert.equal(result.suspicious, true);
  assert.equal(result.score, 80);
  assert.deepEqual(result.reasons, [
    'app_check_unverified', 'reauth_older_than_5m', 'repeated_deletion_request',
  ]);
});
