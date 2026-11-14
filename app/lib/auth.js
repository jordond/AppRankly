const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { DATA_DIR } = require("./config");

const PASSWORD_FILE = path.join(DATA_DIR, ".admin_password");

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  const secretFile = path.join(DATA_DIR, ".jwt_secret");
  if (fs.existsSync(secretFile)) {
    try {
      JWT_SECRET = fs.readFileSync(secretFile, "utf8").trim();
    } catch (e) {
      JWT_SECRET = "dev-insecure-secret-key-fallback";
    }
  } else {
    JWT_SECRET = "dev-insecure-secret-key-" + bcrypt.genSaltSync(10);
    try {
      fs.writeFileSync(secretFile, JWT_SECRET, "utf8");
    } catch (e) {
      JWT_SECRET = "dev-insecure-secret-key-fallback";
    }
  }
}

const isPasswordSet = () => {
  return fs.existsSync(PASSWORD_FILE) || process.env.ADMIN_PASSWORD;
};

const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

// ADMIN_PASSWORD takes precedence over the password file written by the setup flow.
const getStoredAdminPassword = () => {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (fs.existsSync(PASSWORD_FILE)) return fs.readFileSync(PASSWORD_FILE, "utf8").trim();
  return null;
};

// The stored value is either a bcrypt hash (password file, or a pre-hashed ADMIN_PASSWORD)
// or a plaintext ADMIN_PASSWORD. Plaintext is compared in constant time.
const verifyAdminPassword = (password, stored) => {
  if (typeof password !== "string" || !password || !stored) return false;
  if (BCRYPT_HASH_RE.test(stored)) return bcrypt.compareSync(password, stored);
  const a = crypto.createHash("sha256").update(password).digest();
  const b = crypto.createHash("sha256").update(String(stored)).digest();
  return crypto.timingSafeEqual(a, b);
};

const authenticate = (req, res, next) => {
  if (!isPasswordSet()) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing authentication token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: "Forbidden: Admin privileges required" });
  }
  next();
};

module.exports = {
  JWT_SECRET,
  PASSWORD_FILE,
  isPasswordSet,
  getStoredAdminPassword,
  verifyAdminPassword,
  authenticate,
  requireAdmin
};
