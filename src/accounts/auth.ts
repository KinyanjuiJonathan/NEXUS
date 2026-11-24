import type { Secret } from "./types";

/**
 * Sign-in secrets. A PIN or passcode is never stored: only a salted
 * PBKDF2-SHA256 hash of it, so reading the database does not reveal it.
 */

const ITERATIONS = 120_000;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const raw = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS }, key, 256);
  return b64(new Uint8Array(bits));
}

/** At least four characters; anything shorter is too easy to guess. */
export function pinProblem(pin: string): string | null {
  return pin.trim().length < 4 ? "Use at least 4 characters." : null;
}

export async function makeSecret(pin: string): Promise<Secret> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: await derive(pin, salt) };
}

export async function checkSecret(pin: string, secret: Secret | null | undefined): Promise<boolean> {
  if (!secret) return false;
  const hash = await derive(pin, raw(secret.salt));
  // compare every character, so the time taken says nothing about where they differ
  let diff = hash.length ^ secret.hash.length;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ (secret.hash.charCodeAt(i) || 0);
  return diff === 0;
}
