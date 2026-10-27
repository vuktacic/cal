#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';

export const GOOGLE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
]);

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class SafeSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafeSetupError';
  }
}

function fail(message) {
  throw new SafeSetupError(message);
}

export function getDefaultOutputPath(homeDirectory = homedir()) {
  return path.join(homeDirectory, '.config', 'public-availability', 'google-secrets.json');
}

export function parseArgs(argv) {
  const options = { clientPath: undefined, outputPath: undefined, force: false, help: false };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      if (seen.has('help')) fail('An option was supplied more than once.');
      seen.add('help');
      options.help = true;
      continue;
    }
    if (argument === '--force') {
      if (seen.has('force')) fail('An option was supplied more than once.');
      seen.add('force');
      options.force = true;
      continue;
    }
    if (argument !== '--client' && argument !== '--output') {
      fail('Unknown option. Use --help to see supported options.');
    }

    const key = argument === '--client' ? 'clientPath' : 'outputPath';
    if (seen.has(key)) fail('An option was supplied more than once.');
    seen.add(key);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${argument} requires a path.`);
    options[key] = value;
    index += 1;
  }

  if (!options.help && !options.clientPath) fail('--client PATH is required.');
  return options;
}

export function parseDesktopOAuthClient(json) {
  const installed = json && typeof json === 'object' ? json.installed : undefined;
  if (!installed || typeof installed !== 'object') {
    fail('The client file must be a Google Desktop OAuth client JSON file with an installed section.');
  }
  if (typeof installed.client_id !== 'string' || !installed.client_id.trim()) {
    fail('The Desktop OAuth client file is missing its client ID.');
  }
  if (typeof installed.client_secret !== 'string' || !installed.client_secret.trim()) {
    fail('The Desktop OAuth client file is missing its client secret.');
  }
  return {
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
  };
}

export function createAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }) {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  const parameters = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  };
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.toString();
}

export function hasExpectedState(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

export function parseAuthorizationCallback(requestUrl, redirectUri, expectedState) {
  let callbackUrl;
  let expectedOrigin;
  try {
    expectedOrigin = new URL(redirectUri).origin;
    callbackUrl = new URL(requestUrl || '/', redirectUri);
  } catch {
    return { kind: 'invalid' };
  }
  if (callbackUrl.origin !== expectedOrigin) return { kind: 'invalid' };
  if (callbackUrl.pathname !== '/') return { kind: 'other-path' };

  const states = callbackUrl.searchParams.getAll('state');
  if (states.length !== 1 || !hasExpectedState(expectedState, states[0])) {
    return { kind: 'state-mismatch' };
  }

  const errors = callbackUrl.searchParams.getAll('error');
  const codes = callbackUrl.searchParams.getAll('code');
  if (errors.length > 1 || codes.length > 1 || (errors.length && codes.length)) {
    return { kind: 'invalid' };
  }
  if (errors.length === 1) return { kind: 'denied' };
  if (codes.length !== 1 || !codes[0] || codes[0].length > 8192) return { kind: 'invalid' };
  return { kind: 'code', code: codes[0] };
}

export function validateGrantedScopes(scopeValue) {
  if (typeof scopeValue !== 'string' || !scopeValue.trim()) {
    fail('Google did not return granted scopes. No credential file was written.');
  }

  const scopes = scopeValue.trim().split(/\s+/);
  const uniqueScopes = new Set(scopes);
  if (uniqueScopes.size !== scopes.length || uniqueScopes.size !== GOOGLE_SCOPES.length) {
    fail('Google granted scopes that do not exactly match the requested Calendar permissions. No credential file was written.');
  }
  for (const scope of GOOGLE_SCOPES) {
    if (!uniqueScopes.has(scope)) {
      fail('Google granted scopes that do not exactly match the requested Calendar permissions. No credential file was written.');
    }
  }
  return true;
}

function isInsideDirectory(candidatePath, directoryPath) {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

async function assertNoSymlinkComponents(absolutePath) {
  const parsedPath = path.parse(absolutePath);
  let currentPath = parsedPath.root;
  const components = absolutePath.slice(parsedPath.root.length).split(path.sep).filter(Boolean);

  for (const component of components) {
    currentPath = path.join(currentPath, component);
    try {
      const currentStat = await fs.lstat(currentPath);
      if (currentStat.isSymbolicLink()) fail('The credential path contains a symbolic link. Choose a regular private directory and file path.');
    } catch (error) {
      if (error instanceof SafeSetupError) throw error;
      if (error?.code === 'ENOENT') continue;
      fail('The credential path could not be checked safely.');
    }
  }
}

async function ensurePrivateParent(parentPath, mayTightenDefaultDirectory) {
  await assertNoSymlinkComponents(parentPath);

  let existed = true;
  try {
    await fs.lstat(parentPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('The credential directory could not be checked safely.');
    existed = false;
  }

  try {
    await fs.mkdir(parentPath, { recursive: true, mode: 0o700 });
  } catch {
    fail('Could not create the private credential directory.');
  }

  await assertNoSymlinkComponents(parentPath);
  let directoryStat;
  try {
    directoryStat = await fs.lstat(parentPath);
  } catch {
    fail('The credential directory could not be checked safely.');
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail('The credential output parent must be a regular directory.');
  }
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    fail('The credential output directory must be owned by the current user.');
  }

  if (process.platform !== 'win32') {
    const permissions = directoryStat.mode & 0o777;
    if (permissions !== 0o700) {
      if (existed && mayTightenDefaultDirectory) {
        try {
          await fs.chmod(parentPath, 0o700);
        } catch {
          fail('Could not restrict the credential directory permissions to owner-only.');
        }
      } else if (existed) {
        fail('The existing credential directory must have mode 0700. Restrict that directory or choose a new private directory.');
      }
    }
  }
}

async function inspectOutputPath({ outputPath, force = false, repositoryRoot = REPOSITORY_ROOT, defaultOutput = false }) {
  const absoluteOutputPath = path.resolve(outputPath);
  if (isInsideDirectory(absoluteOutputPath, path.resolve(repositoryRoot))) {
    fail('Credential output must be outside the repository.');
  }

  const parentPath = path.dirname(absoluteOutputPath);
  await ensurePrivateParent(parentPath, defaultOutput && absoluteOutputPath === path.resolve(getDefaultOutputPath()));
  await assertNoSymlinkComponents(absoluteOutputPath);

  let existingStat;
  try {
    existingStat = await fs.lstat(absoluteOutputPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('The credential output path could not be checked safely.');
  }

  if (existingStat) {
    if (existingStat.isSymbolicLink()) fail('The credential output path is a symbolic link. Choose a regular file path.');
    if (!existingStat.isFile()) fail('The credential output path must be a regular file.');
    if (typeof process.getuid === 'function' && existingStat.uid !== process.getuid()) {
      fail('The existing credential file must be owned by the current user.');
    }
    if (!force) fail('The credential file already exists. Use --force to replace it.');
  }
  return absoluteOutputPath;
}

function isAlreadyExistsError(error) {
  return error?.code === 'EEXIST';
}

export async function saveSecretFile({ outputPath, credentials, force = false, repositoryRoot = REPOSITORY_ROOT, defaultOutput = false }) {
  const absoluteOutputPath = await inspectOutputPath({ outputPath, force, repositoryRoot, defaultOutput });
  const parentPath = path.dirname(absoluteOutputPath);

  const temporaryPath = path.join(parentPath, `.google-secrets-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
  let temporaryHandle;
  try {
    temporaryHandle = await fs.open(temporaryPath, 'wx', 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.chmod(0o600);
    await temporaryHandle.close();
    temporaryHandle = undefined;

    if (force) {
      await fs.rename(temporaryPath, absoluteOutputPath);
    } else {
      await fs.link(temporaryPath, absoluteOutputPath);
      await fs.unlink(temporaryPath);
    }
  } catch (error) {
    try {
      if (temporaryHandle) await temporaryHandle.close();
      await fs.unlink(temporaryPath);
    } catch {
      // The temporary file may already have been removed or never created.
    }
    if (isAlreadyExistsError(error)) fail('The credential file already exists. Use --force to replace it.');
    if (error instanceof SafeSetupError) throw error;
    fail('Could not save the credential file securely.');
  }

  if (process.platform !== 'win32') {
    try {
      const savedStat = await fs.lstat(absoluteOutputPath);
      if ((savedStat.mode & 0o777) !== 0o600) {
        await fs.chmod(absoluteOutputPath, 0o600);
      }
    } catch {
      fail('Could not verify owner-only permissions on the credential file.');
    }
  }
  return absoluteOutputPath;
}

async function readClientFile(clientPath) {
  const absoluteClientPath = path.resolve(clientPath);
  if (isInsideDirectory(absoluteClientPath, REPOSITORY_ROOT)) {
    fail('Keep the Desktop OAuth client file outside the repository.');
  }
  let clientStat;
  try {
    clientStat = await fs.lstat(absoluteClientPath);
  } catch {
    fail('Could not read the Desktop OAuth client file.');
  }
  if (!clientStat.isFile() || clientStat.isSymbolicLink()) {
    fail('The Desktop OAuth client path must be a regular file, not a symbolic link.');
  }

  let fileContents;
  try {
    fileContents = await fs.readFile(absoluteClientPath, 'utf8');
  } catch {
    fail('Could not read the Desktop OAuth client file.');
  }
  let clientJson;
  try {
    clientJson = JSON.parse(fileContents);
  } catch {
    fail('The Desktop OAuth client file is not valid JSON.');
  }
  return parseDesktopOAuthClient(clientJson);
}

function writeCallbackResponse(response, statusCode, message) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(message);
}

async function receiveAuthorizationCode(server, expectedState, redirectUri) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(false, new SafeSetupError('Authorization timed out. Run the command again to retry.')), CALLBACK_TIMEOUT_MS);
    timeout.unref();
    const onSignal = () => finish(false, new SafeSetupError('Authorization was cancelled.'));
    process.once('SIGINT', onSignal);

    const finish = (success, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.removeListener('SIGINT', onSignal);
      if (success) resolve(value);
      else reject(value);
    };

    server.on('request', (request, response) => {
      if (settled) {
        writeCallbackResponse(response, 410, 'This authorization request is already complete.');
        return;
      }
      if (request.method !== 'GET') {
        writeCallbackResponse(response, 405, 'Use the Google authorization link to continue.');
        return;
      }

      const callbackResult = parseAuthorizationCallback(request.url, redirectUri, expectedState);
      if (callbackResult.kind === 'other-path') {
        writeCallbackResponse(response, 404, 'No handler at this path.');
        return;
      }
      if (callbackResult.kind === 'state-mismatch') {
        writeCallbackResponse(response, 400, 'Authorization state did not match. Return to the terminal.');
        finish(false, new SafeSetupError('Google returned a missing or mismatched state. No credential file was written.'));
        return;
      }
      if (callbackResult.kind === 'denied') {
        writeCallbackResponse(response, 403, 'Authorization was not granted. You can close this tab.');
        finish(false, new SafeSetupError('Authorization was denied or cancelled. No credential file was written.'));
        return;
      }
      if (callbackResult.kind !== 'code') {
        writeCallbackResponse(response, 400, 'Google did not return an authorization code.');
        finish(false, new SafeSetupError('Google did not return a usable authorization code. No credential file was written.'));
        return;
      }

      writeCallbackResponse(response, 200, 'Authorization received. Return to the terminal to finish setup.');
      finish(true, callbackResult.code);
    });
  });
}

function browserCandidates(authorizationUrl) {
  if (process.platform === 'win32') return [['rundll32.exe', ['url.dll,FileProtocolHandler', authorizationUrl]]];
  if (process.platform === 'darwin') return [['open', [authorizationUrl]]];
  if (process.env.WSL_DISTRO_NAME) {
    return [
      ['wslview', [authorizationUrl]],
      ['xdg-open', [authorizationUrl]],
      ['explorer.exe', [authorizationUrl]],
    ];
  }
  return [['xdg-open', [authorizationUrl]]];
}

async function tryOpenBrowser(authorizationUrl) {
  for (const [command, argumentsList] of browserCandidates(authorizationUrl)) {
    const opened = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, argumentsList, { detached: true, shell: false, stdio: 'ignore' });
      } catch {
        resolve(false);
        return;
      }
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
    if (opened) return true;
  }
  return false;
}

async function exchangeAuthorizationCode({ code, codeVerifier, redirectUri, client }) {
  const requestBody = new URLSearchParams({
    code,
    code_verifier: codeVerifier,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  let response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: requestBody,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      fail('Google OAuth token exchange timed out. No credential file was written.');
    }
    fail('Could not reach Google OAuth. Check the network connection and retry.');
  }

  let tokenResponse;
  try {
    tokenResponse = await response.json();
  } catch {
    fail('Google returned an unreadable token response. No credential file was written.');
  }
  if (!response.ok) {
    if (tokenResponse?.error === 'invalid_grant') {
      fail('Google rejected the authorization code. It may have expired or already been used. Run the command again.');
    }
    fail('Google rejected the OAuth token exchange. No credential file was written.');
  }
  if (typeof tokenResponse.refresh_token !== 'string' || !tokenResponse.refresh_token.trim()) {
    fail('Google did not return a refresh token. No credential file was written. Confirm offline access and consent settings, then retry.');
  }
  validateGrantedScopes(tokenResponse.scope);
  return tokenResponse.refresh_token;
}

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    const onError = () => reject(new SafeSetupError('Could not start the local OAuth callback listener.'));
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') fail('Could not determine the local OAuth callback address.');
  return `http://127.0.0.1:${address.port}/`;
}

async function runAuthorization({ client, outputPath, force, defaultOutput }) {
  const server = createServer();
  const redirectUri = await listenOnLoopback(server);
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const authorizationUrl = createAuthorizationUrl({ clientId: client.clientId, redirectUri, state, codeChallenge });

  try {
    const authorizationCodePromise = receiveAuthorizationCode(server, state, redirectUri);
    console.log('Open this Google authorization URL in your browser:');
    console.log(authorizationUrl);
    await tryOpenBrowser(authorizationUrl);
    console.log('If the browser did not open, copy the URL above. Approve the two Calendar permissions in Google.');
    console.log('Waiting up to five minutes for the local callback. Press Ctrl-C to cancel.');

    const authorizationCode = await authorizationCodePromise;
    const refreshToken = await exchangeAuthorizationCode({
      code: authorizationCode,
      codeVerifier,
      redirectUri,
      client,
    });
    const savedPath = await saveSecretFile({
      outputPath,
      credentials: {
        GOOGLE_CLIENT_ID: client.clientId,
        GOOGLE_CLIENT_SECRET: client.clientSecret,
        GOOGLE_REFRESH_TOKEN: refreshToken,
      },
      force,
      defaultOutput,
    });
    console.log(`Saved owner-only Google OAuth credentials to ${savedPath}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function usage() {
  return [
    'Usage: node scripts/google-auth.mjs --client PATH [--output PATH] [--force]',
    '',
    '  --client PATH   Google OAuth Desktop client JSON downloaded from Google Cloud',
    '  --output PATH   Private output file (default: ~/.config/public-availability/google-secrets.json)',
    '  --force         Replace an existing regular output file owned by the current user',
    '  --help          Show this help',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof SafeSetupError) fail(error.message);
    throw error;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (process.platform === 'win32') {
    fail('Run this setup from WSL, Linux, or macOS so the credential directory and file can be restricted to the current user.');
  }

  const client = await readClientFile(options.clientPath);
  const defaultOutput = options.outputPath === undefined;
  const outputPath = options.outputPath || getDefaultOutputPath();
  await inspectOutputPath({ outputPath, force: options.force, defaultOutput });
  await runAuthorization({ client, outputPath, force: options.force, defaultOutput });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    if (error instanceof SafeSetupError) console.error(`Google OAuth setup failed: ${error.message}`);
    else console.error('Google OAuth setup failed. No credential file was written.');
    process.exitCode = 1;
  });
}
