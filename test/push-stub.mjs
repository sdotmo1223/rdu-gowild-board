// Shared test fixture for the app's push channel. Keys are generated per run so no
// secret is ever committed, and the subscription is a real P-256 point so the payload
// is actually encrypted on the way out.
import { toB64u } from '../src/push.mjs';

const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

export const VAPID = {
  VAPID_PUBLIC: toB64u(raw),
  VAPID_PRIVATE: String(jwk.d),
};

export const SUB_ENDPOINT = 'https://fcm.googleapis.com/wp/test-endpoint-0001';

export const SUBSCRIPTION = {
  endpoint: SUB_ENDPOINT,
  keys: {
    p256dh: toB64u(raw),
    auth: toB64u(new Uint8Array(16).fill(7)),
  },
  profile: 'rdu',
  label: 'test',
  at: 1,
};

// A KV stub that already holds one enrolled device, so `deliver` reaches the push path
// exactly as it would in production.
export async function seedDevice(store, sub = SUBSCRIPTION) {
  await store.put(`push:${sub.profile || 'rdu'}test`, JSON.stringify(sub));
  return sub;
}

export function withKeys(env) {
  return { ...env, ...VAPID };
}

const enc = new TextEncoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(ikm, salt, info, bytes) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

// The device side of RFC 8291. It exists so a test can assert what the notification
// actually says instead of trusting that it was sent -- the same property the phone
// demonstrated, checked in the suite.
export async function decryptPayload(bytes, authB64 = SUBSCRIPTION.keys.auth) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const salt = b.slice(0, 16);
  const idlen = b[20];
  const asPub = b.slice(21, 21 + idlen);
  const ct = b.slice(21 + idlen);
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, priv, 256));
  const auth = new Uint8Array(atob(authB64.replace(/-/g, '+').replace(/_/g, '/')).split('').map((c) => c.charCodeAt(0)));
  const ikm = await hkdf(shared, auth, concat(enc.encode('WebPush: info'), new Uint8Array([0]), raw, asPub), 32);
  const cek = await hkdf(ikm, salt, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.length - 1)));
}
