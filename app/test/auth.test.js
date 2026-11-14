const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/config reads DATA_DIR at load time, so point it at a temp dir before requiring lib/auth.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprankly-auth-'));
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;

const bcrypt = require('bcryptjs');
const auth = require('../lib/auth');

function testVerifyAdminPassword() {
  const hash = bcrypt.hashSync('s3cret-pass', 4);

  assert.strictEqual(auth.verifyAdminPassword('s3cret-pass', hash), true, 'bcrypt hash must match its password');
  assert.strictEqual(auth.verifyAdminPassword('wrong', hash), false, 'bcrypt hash must reject a wrong password');
  assert.strictEqual(auth.verifyAdminPassword(hash, hash), false, 'the hash itself is not a valid password');

  assert.strictEqual(auth.verifyAdminPassword('plain-pass', 'plain-pass'), true, 'plaintext ADMIN_PASSWORD must match');
  assert.strictEqual(auth.verifyAdminPassword('plain-pasS', 'plain-pass'), false, 'plaintext compare is exact');
  assert.strictEqual(auth.verifyAdminPassword('plain', 'plain-pass'), false, 'plaintext prefix must not match');

  assert.strictEqual(auth.verifyAdminPassword('', 'plain-pass'), false, 'empty password never matches');
  assert.strictEqual(auth.verifyAdminPassword('x', null), false, 'missing stored value never matches');
  assert.strictEqual(auth.verifyAdminPassword(undefined, hash), false, 'undefined password never matches');
  console.log('✓ verifyAdminPassword accepts bcrypt hashes and plaintext');
}

function testGetStoredAdminPassword() {
  assert.strictEqual(auth.getStoredAdminPassword(), null, 'nothing stored on a fresh data dir');

  fs.writeFileSync(auth.PASSWORD_FILE, 'file-hash\n');
  assert.strictEqual(auth.getStoredAdminPassword(), 'file-hash', 'password file is read and trimmed');

  process.env.ADMIN_PASSWORD = 'env-pass';
  assert.strictEqual(auth.getStoredAdminPassword(), 'env-pass', 'ADMIN_PASSWORD wins over the password file');

  delete process.env.ADMIN_PASSWORD;
  fs.rmSync(auth.PASSWORD_FILE);
  console.log('✓ getStoredAdminPassword prefers ADMIN_PASSWORD over the password file');
}

function runAuthenticate(headers = {}) {
  const result = { nextCalled: false, status: 200, body: null };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; }
  };
  auth.authenticate({ headers }, res, () => { result.nextCalled = true; });
  return result;
}

function testAuthenticateBeforeSetup() {
  delete process.env.ALLOW_UNAUTHENTICATED;
  let r = runAuthenticate();
  assert.strictEqual(r.nextCalled, false, 'no password set: request must not pass');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.setupRequired, true);

  process.env.ALLOW_UNAUTHENTICATED = 'true';
  r = runAuthenticate();
  assert.strictEqual(r.nextCalled, true, 'ALLOW_UNAUTHENTICATED=true opens the API when no password is set');

  // The opt-out never weakens an instance that has a password.
  process.env.ADMIN_PASSWORD = 'env-pass';
  r = runAuthenticate();
  assert.strictEqual(r.nextCalled, false, 'password set: a token is required even with ALLOW_UNAUTHENTICATED');
  assert.strictEqual(r.status, 401);

  r = runAuthenticate({ authorization: 'Bearer not-a-jwt' });
  assert.strictEqual(r.status, 401, 'invalid token is rejected');

  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ username: 'admin', role: 'admin' }, auth.JWT_SECRET);
  r = runAuthenticate({ authorization: `Bearer ${token}` });
  assert.strictEqual(r.nextCalled, true, 'valid token passes');

  delete process.env.ADMIN_PASSWORD;
  delete process.env.ALLOW_UNAUTHENTICATED;
  console.log('✓ authenticate blocks the API until a password is set');
}

try {
  testVerifyAdminPassword();
  testGetStoredAdminPassword();
  testAuthenticateBeforeSetup();
  console.log('All auth tests passed!');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
