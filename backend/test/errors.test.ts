import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { logApiError } from '../src/errors.js';

describe('API error diagnostics', () => {
  it('logs a useful message and stack while redacting secrets and personal data', () => {
    const originalError = console.error;
    let output = '';
    console.error = (message?: unknown) => { output = String(message); };

    try {
      const error = Object.assign(
        new Error('Database rejected user@example.com using sb_secret_test-secret access_token=private-token-value and https://user:password@example.com/path'),
        {
          code: '42501',
          status: 403,
          details: 'Key (actor_id)=(Example Person) is not present',
          hint: 'Check service_role access',
        },
      );
      logApiError('test.operation', error);
    } finally {
      console.error = originalError;
    }

    const diagnostic = JSON.parse(output) as Record<string, unknown>;
    assert.equal(diagnostic.operation, 'test.operation');
    assert.match(diagnostic.errorMessage as string, /Database rejected/);
    assert.equal(diagnostic.errorCode, '42501');
    assert.equal(diagnostic.httpStatus, 403);
    assert.match(diagnostic.errorDetails as string, /Key \(actor_id\)/);
    assert.doesNotMatch(diagnostic.errorDetails as string, /Example Person/);
    assert.equal(diagnostic.errorHint, 'Check service_role access');
    assert.doesNotMatch(output, /user@example\.com|sb_secret_test-secret|private-token-value|user:password/);
    assert.match(diagnostic.stack as string, /at /);
  });
});
