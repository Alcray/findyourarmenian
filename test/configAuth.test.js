import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const EMPTY_AUTH = {
  AUTH_PASSWORD: '',
  AUTH_SESSION_SECRET: '',
  APP_PASSWORD: '',
  SESSION_SECRET: '',
};

function importConfig(env = {}, source = "await import('./src/config.js')") {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...EMPTY_AUTH, ...env },
  });
}

test('authentication can remain disabled locally but fails closed in production', () => {
  const local = importConfig({ NODE_ENV: '', RAILWAY_ENVIRONMENT: '', RAILWAY_PUBLIC_DOMAIN: '' });
  assert.equal(local.status, 0, local.stderr);

  const production = importConfig({ NODE_ENV: 'production', RAILWAY_ENVIRONMENT: '', RAILWAY_PUBLIC_DOMAIN: '' });
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /Authentication is required in production/);
});

test('Railway domains are added to the request Host allowlist automatically', () => {
  const result = importConfig(
    {
      NODE_ENV: 'production',
      RAILWAY_ENVIRONMENT: 'production',
      RAILWAY_PUBLIC_DOMAIN: 'findyourarmenian-production.up.railway.app',
      AUTH_PASSWORD: 'a-long-production-password',
      AUTH_SESSION_SECRET: 'a-production-session-secret-with-at-least-32-bytes',
    },
    "const { config } = await import('./src/config.js'); process.stdout.write(JSON.stringify(config.allowedHosts))",
  );
  assert.equal(result.status, 0, result.stderr);
  const allowedHosts = JSON.parse(result.stdout);
  assert.ok(allowedHosts.includes('findyourarmenian-production.up.railway.app'));
  assert.ok(allowedHosts.includes('healthcheck.railway.app'));
});
