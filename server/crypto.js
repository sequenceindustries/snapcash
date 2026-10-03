import crypto from 'node:crypto';
import { config } from './config.js';

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Six-digit code, uniformly random.
export function otpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Code hashes are bound to the OTP row id so a leaked hash can't be replayed elsewhere.
export function otpHash(otpId, code) {
  return crypto.createHmac('sha256', config.sessionSecret).update(`${otpId}:${code}`).digest();
}

export function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Tamper-proof small payloads for short-lived cookies.
export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function unsign(value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const [body, mac] = value.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  if (!safeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
