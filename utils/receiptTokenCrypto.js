const crypto = require("crypto");

const RECEIPT_TOKEN_PREFIX = "EDM1:";
const TOKEN_PATTERN = /^EDM1:[A-Za-z0-9_-]{43}$/;

function getEncryptionKey() {
  const encoded = process.env.RECEIPT_TOKEN_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error("RECEIPT_TOKEN_ENCRYPTION_KEY is required");
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error("RECEIPT_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("RECEIPT_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

function validateReceiptTokenConfiguration() {
  getEncryptionKey();
}

function createReceiptToken() {
  return `${RECEIPT_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function normalizeReceiptToken(value) {
  if (typeof value !== "string" || value.length !== 48 || !TOKEN_PATTERN.test(value)) {
    return null;
  }
  return value;
}

function hashReceiptToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function encryptReceiptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decryptReceiptToken(value) {
  const parts = typeof value === "string" ? value.split(".") : [];
  if (parts.length !== 3) throw new Error("Invalid receipt token ciphertext");
  const [iv, authTag, encrypted] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || authTag.length !== 16 || encrypted.length === 0) {
    throw new Error("Invalid receipt token ciphertext");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

module.exports = {
  TOKEN_PATTERN,
  createReceiptToken,
  decryptReceiptToken,
  encryptReceiptToken,
  hashReceiptToken,
  normalizeReceiptToken,
  validateReceiptTokenConfiguration,
};
