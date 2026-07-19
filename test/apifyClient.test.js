import assert from 'node:assert/strict';
import test from 'node:test';

import { pickCompanyLinkedInUrl, resolveCompanyLinkedInUrl } from '../src/apifyClient.js';

test('company resolution accepts only a strong normalized name match', async () => {
  assert.equal(
    pickCompanyLinkedInUrl(
      [
        { name: 'Unrelated Labs', linkedinUrl: 'https://www.linkedin.com/company/unrelated' },
        { name: 'Acme, Inc.', linkedinUrl: 'https://am.linkedin.com/company/%61cme/?trk=fixture' },
      ],
      'Acme',
    ),
    'https://www.linkedin.com/company/acme',
  );
  assert.equal(
    pickCompanyLinkedInUrl(
      [{ name: 'Unrelated Labs', linkedinUrl: 'https://www.linkedin.com/company/unrelated' }],
      'Acme',
    ),
    '',
  );
  assert.equal(
    pickCompanyLinkedInUrl(
      [{ name: 'Metaverse Labs', linkedinUrl: 'https://www.linkedin.com/company/metaverse-labs' }],
      'Meta',
    ),
    '',
  );
  assert.equal(
    pickCompanyLinkedInUrl(
      [{ name: 'Unrelated Labs', linkedinUrl: 'https://www.linkedin.com/company/unrelated' }],
      '!!!',
    ),
    '',
  );
  assert.equal(
    pickCompanyLinkedInUrl(
      [{ name: 'Acme', linkedinUrl: 'https://notlinkedin.com/company/acme' }],
      'Acme',
    ),
    '',
  );

  // Common companies resolve locally, with no token or actor call.
  assert.equal((await resolveCompanyLinkedInUrl('OpenAI')).url, 'https://www.linkedin.com/company/openai');
});
