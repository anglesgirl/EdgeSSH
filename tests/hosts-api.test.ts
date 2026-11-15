import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Env } from '../src/types.ts';
import { encryptHost } from '../src/accounts/crypto.ts';
import { hostsRoute, type HostPayload } from '../src/accounts/hosts.ts';

const accountId = 'test-account';
const hostId = '00000000-0000-4000-8000-000000000001';
const encryptionKey = Buffer.alloc(32, 9).toString('base64');
const dummyPrivateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nDUMMY TEST KEY\n-----END OPENSSH PRIVATE KEY-----';

function testPayload(authMethod: 'password' | 'publickey'): HostPayload {
  return {
    name: 'Dummy host', group: 'Test', host: '192.0.2.10', port: 22, username: 'test', authMethod,
    ...(authMethod === 'publickey' ? { privateKey: dummyPrivateKey } : { password: 'dummy-password' }),
    initialCommand: '', termType: 'xterm-256color', encoding: 'utf-8', fingerprint: '',
    location: { ip: '192.0.2.10', city: 'Test', country: 'Test', countryCode: 'ZZ', latitude: 0, longitude: 0 },
    locationCheckedAt: Date.now(),
  };
}

async function testEnv(payload: HostPayload): Promise<Env> {
  const row = {
    id: hostId,
    encrypted_payload: await encryptHost(payload, encryptionKey, accountId, hostId),
    updated_at: Date.now(),
  };
  const DB = {
    prepare() {
      const statement = {
        bind() { return statement; },
        async first<T>() { return row as T; },
        async all<T>() { return { results: [row as T] }; },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { DB, ENCRYPTION_KEY: encryptionKey } as unknown as Env;
}

function request(path: string, method = 'GET', body?: Record<string, unknown>): Request {
  return new Request(`https://ssh.example.test${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function credentials(payload: HostPayload, purpose: Record<string, unknown>) {
  return hostsRoute(
    request(`/api/hosts/${hostId}/credentials`, 'POST', purpose),
    await testEnv(payload), accountId, `/api/hosts/${hostId}/credentials`,
  );
}

test('host list exposes only credential presence, never credential contents', async () => {
  const path = '/api/hosts';
  const response = await hostsRoute(request(path), await testEnv(testPayload('publickey')), accountId, path);
  const result = await response.json() as { hosts: Record<string, unknown>[] };
  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].hasCredential, true);
  assert.equal('privateKey' in result.hosts[0], false);
  assert.equal('password' in result.hosts[0], false);
});

test('public-key credentials are returned only for an explicit connect purpose', async () => {
  const payload = testPayload('publickey');
  const response = await credentials(payload, { purpose: 'connect' });
  const result = await response.json() as Record<string, unknown>;
  assert.deepEqual(result, { privateKey: dummyPrivateKey });

  const wrongPurpose = await credentials(payload, { purpose: 'password-field' });
  assert.deepEqual(await wrongPurpose.json(), { hasCredential: true });
});

test('password connection and password-field behavior return only the password', async () => {
  const payload = testPayload('password');
  for (const purpose of ['connect', 'password-field']) {
    const response = await credentials(payload, { purpose });
    const result = await response.json() as Record<string, unknown>;
    assert.deepEqual(result, { password: 'dummy-password' });
    assert.equal('privateKey' in result, false);
  }
});

test('credential endpoint rejects requests without an explicit purpose', async () => {
  const path = `/api/hosts/${hostId}/credentials`;
  await assert.rejects(hostsRoute(request(path, 'POST', {}), await testEnv(testPayload('publickey')), accountId, path), /凭据用途无效/);
  await assert.rejects(hostsRoute(request(path), await testEnv(testPayload('publickey')), accountId, path), /不支持此请求方法/);
});

test('updating an existing public-key host without a privateKey field preserves the saved key', async () => {
  const path = `/api/hosts/${hostId}`;
  const response = await hostsRoute(request(path, 'PUT', {
    name: 'Dummy host', group: 'Test', host: '192.0.2.10', port: 22, username: 'test', authMethod: 'publickey',
    initialCommand: '', termType: 'xterm-256color', encoding: 'utf-8', fingerprint: '',
  }), await testEnv(testPayload('publickey')), accountId, path);
  const result = await response.json() as { host: Record<string, unknown> };
  assert.equal(result.host.hasCredential, true);
  assert.equal('privateKey' in result.host, false);
});
