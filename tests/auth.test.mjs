import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, lstat, chmod, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GOOGLE_SCOPES,
  createAuthorizationUrl,
  getDefaultOutputPath,
  hasExpectedState,
  main,
  parseArgs,
  parseAuthorizationCallback,
  parseDesktopOAuthClient,
  saveSecretFile,
  validateGrantedScopes,
} from '../scripts/google-auth.mjs';

const CLIENT_ID = 'desktop-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';
const REFRESH_TOKEN = 'test-refresh-token';

test('default credentials path is under the app-specific user config directory', () => {
  assert.equal(
    getDefaultOutputPath('/home/example'),
    '/home/example/.config/public-availability/google-secrets.json',
  );
});

test('argument parsing requires a client and supports an optional output and force flag', () => {
  assert.deepEqual(parseArgs(['--client', 'desktop.json']), {
    clientPath: 'desktop.json',
    outputPath: undefined,
    force: false,
    help: false,
  });
  assert.deepEqual(parseArgs(['--client', 'desktop.json', '--output', '/tmp/private/secret.json', '--force']), {
    clientPath: 'desktop.json',
    outputPath: '/tmp/private/secret.json',
    force: true,
    help: false,
  });
  assert.throws(() => parseArgs([]), /--client PATH is required/);
  assert.throws(() => parseArgs(['--client']), /--client requires a path/);
  assert.throws(() => parseArgs(['--client', 'a.json', '--client', 'b.json']), /more than once/);
});

test('Desktop OAuth JSON parser accepts installed credentials and rejects web clients', () => {
  assert.deepEqual(parseDesktopOAuthClient({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }), {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  assert.throws(() => parseDesktopOAuthClient({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }), /Desktop OAuth client JSON/);
  assert.throws(() => parseDesktopOAuthClient({ installed: { client_id: CLIENT_ID } }), /client secret/);
});

test('CLI rejects a Desktop client JSON path inside the repository before reading it', async () => {
  await assert.rejects(main(['--client', path.join(path.dirname(new URL(import.meta.url).pathname), 'client.json')]), /outside the repository/);
});

test('authorization URL requests only the two intended scopes with state, PKCE, and offline consent', () => {
  const url = new URL(createAuthorizationUrl({
    clientId: CLIENT_ID,
    redirectUri: 'http://127.0.0.1:43210/',
    state: 'random-state',
    codeChallenge: 'pkce-challenge',
  }));

  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:43210/');
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.deepEqual(url.searchParams.get('scope').split(' '), GOOGLE_SCOPES);
  assert.equal(url.searchParams.has('include_granted_scopes'), false);
  assert.equal(url.href.includes(CLIENT_SECRET), false);
});

test('callback state comparison requires exact values', () => {
  assert.equal(hasExpectedState('a-long-random-state', 'a-long-random-state'), true);
  assert.equal(hasExpectedState('a-long-random-state', 'a-long-random-statf'), false);
  assert.equal(hasExpectedState('expected', undefined), false);
});

test('OAuth callback accepts one matching state and code, and handles denial without echoing provider text', () => {
  assert.deepEqual(
    parseAuthorizationCallback('/?state=expected&code=authorization-code', 'http://127.0.0.1:43210/', 'expected'),
    { kind: 'code', code: 'authorization-code' },
  );
  assert.deepEqual(
    parseAuthorizationCallback('/?state=wrong&code=authorization-code', 'http://127.0.0.1:43210/', 'expected'),
    { kind: 'state-mismatch' },
  );
  assert.deepEqual(
    parseAuthorizationCallback('/?code=authorization-code', 'http://127.0.0.1:43210/', 'expected'),
    { kind: 'state-mismatch' },
  );
  assert.deepEqual(
    parseAuthorizationCallback('/?state=expected&error=access_denied&error_description=private-detail', 'http://127.0.0.1:43210/', 'expected'),
    { kind: 'denied' },
  );
  assert.deepEqual(
    parseAuthorizationCallback('/?state=expected&state=expected&code=authorization-code', 'http://127.0.0.1:43210/', 'expected'),
    { kind: 'state-mismatch' },
  );
  assert.deepEqual(
    parseAuthorizationCallback('/?state=expected&code=one&code=two', 'http://127.0.0.1:43210/', 'expected'),
    { kind: 'invalid' },
  );
  assert.deepEqual(
    parseAuthorizationCallback('http://other.example/?state=expected&code=authorization-code', 'http://127.0.0.1:43210/', 'expected'),
    { kind: 'invalid' },
  );
});

test('granted scopes must be exactly the two requested Calendar scopes', () => {
  assert.equal(validateGrantedScopes([...GOOGLE_SCOPES].reverse().join(' ')), true);
  assert.throws(() => validateGrantedScopes(undefined), /did not return granted scopes/);
  assert.throws(() => validateGrantedScopes(`${GOOGLE_SCOPES.join(' ')} https://www.googleapis.com/auth/calendar.readonly`), /do not exactly match/);
  assert.throws(() => validateGrantedScopes(GOOGLE_SCOPES[0]), /do not exactly match/);
  assert.throws(() => validateGrantedScopes(`${GOOGLE_SCOPES.join(' ')} ${GOOGLE_SCOPES[0]}`), /do not exactly match/);
});

test('credential save is atomic, owner-only, and refuses overwrite unless forced', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'public-availability-auth-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const privateDirectory = path.join(temporaryRoot, 'private');
  const outputPath = path.join(privateDirectory, 'google-secrets.json');
  const credentials = {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN,
  };

  await saveSecretFile({
    outputPath,
    credentials,
    repositoryRoot: path.join(temporaryRoot, 'repo'),
  });
  const saved = await lstat(outputPath);
  const directory = await lstat(privateDirectory);
  if (process.platform !== 'win32') {
    assert.equal(saved.mode & 0o777, 0o600);
    assert.equal(directory.mode & 0o777, 0o700);
  }
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), credentials);

  await assert.rejects(
    saveSecretFile({ outputPath, credentials: { ...credentials, GOOGLE_REFRESH_TOKEN: 'replacement' }, repositoryRoot: path.join(temporaryRoot, 'repo') }),
    /already exists.*--force/,
  );
  await saveSecretFile({
    outputPath,
    credentials: { ...credentials, GOOGLE_REFRESH_TOKEN: 'replacement' },
    force: true,
    repositoryRoot: path.join(temporaryRoot, 'repo'),
  });
  assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).GOOGLE_REFRESH_TOKEN, 'replacement');
});

test('credential save rejects repository paths and symbolic links', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'public-availability-auth-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repositoryRoot = path.join(temporaryRoot, 'repo');
  await mkdir(repositoryRoot, { mode: 0o700 });
  const credentials = {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN,
  };

  await assert.rejects(
    saveSecretFile({ outputPath: path.join(repositoryRoot, 'secret.json'), credentials, repositoryRoot }),
    /outside the repository/,
  );

  const privateDirectory = path.join(temporaryRoot, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  if (process.platform !== 'win32') await chmod(privateDirectory, 0o700);
  const targetPath = path.join(privateDirectory, 'target.json');
  const linkPath = path.join(privateDirectory, 'google-secrets.json');
  await symlink(targetPath, linkPath);
  await assert.rejects(
    saveSecretFile({ outputPath: linkPath, credentials, repositoryRoot }),
    /symbolic link/,
  );
});
