import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getApiRequestUrl } from '../src/api-url.js';

describe('API request URL configuration', () => {
  it('keeps relative URLs in local development even if a production origin is configured', () => {
    assert.equal(
      getApiRequestUrl('/api/health', 'development', 'https://backend.example.test'),
      '/api/health',
    );
  });

  it('uses the configured backend origin and preserves nested API paths', () => {
    assert.equal(
      getApiRequestUrl('/api/approvals/status', 'production', 'https://backend.example.test/'),
      'https://backend.example.test/api/approvals/status',
    );
  });

  it('keeps relative URLs for same-origin production deployments', () => {
    assert.equal(getApiRequestUrl('/api/consents', 'production', '  '), '/api/consents');
  });
});
