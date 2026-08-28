import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoKnownCredentialLeak, collectSecretLikeStrings } from '../scripts/lib/publication-guard.mjs';

test('known clean-room credential values fail closed without appearing in the error', () => {
  const credential = 'fake-clean-room-token-123456';
  const known = new Set(collectSecretLikeStrings({ auth: { access_token: credential, label: 'not-secret' } }));
  assert.deepEqual([...known], [credential]);
  assert.throws(
    () => assertNoKnownCredentialLeak(`candidate diff accidentally contains ${credential}`, known),
    (error) => !String(error.message).includes(credential) && /refusing to publish/.test(error.message)
  );
  assert.doesNotThrow(() => assertNoKnownCredentialLeak('normal candidate output', known));
});
