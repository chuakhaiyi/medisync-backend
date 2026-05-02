/**
 * PHI Encryption Utility
 * Uses AES-256-GCM for authenticated encryption of Protected Health Information.
 * The IV is prepended to the ciphertext and stored together (safe to store in DB).
 */

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // GCM recommended IV size
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.PHI_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('PHI_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string (PHI field).
 * Returns a base64 string: IV(12) + AuthTag(16) + Ciphertext
 */
export function encryptPHI(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Layout: [IV 12 bytes][AuthTag 16 bytes][Ciphertext N bytes]
  const result = Buffer.concat([iv, authTag, encrypted]);
  return result.toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted PHI field.
 * Returns the original plaintext.
 */
export function decryptPHI(encoded: string): string {
  const key = getKey();
  const data = Buffer.from(encoded, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Safely decrypt — returns null instead of throwing if decryption fails.
 * Use for non-critical fields where missing data is acceptable.
 */
export function safeDecryptPHI(encoded: string | null | undefined): string | null {
  if (!encoded) return null;
  try {
    return decryptPHI(encoded);
  } catch {
    return null;
  }
}
