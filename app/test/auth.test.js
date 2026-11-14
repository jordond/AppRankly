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

try {
  testVerifyAdminPassword();
  testGetStoredAdminPassword();
  console.log('All auth tests passed!');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
