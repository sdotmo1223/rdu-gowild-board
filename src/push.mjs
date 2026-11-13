// Web Push with no dependency and no provider: RFC 8030 (delivery), RFC 8291 (payload
// encryption) and RFC 8292 (VAPID) on top of WebCrypto, which the Worker already has.
//
// Why this exists: every update used to arrive through ntfy.sh and the ntfy app, which
// meant two faces for one process — a second app to install, a topic to trust, and a
// notification that could not be traced back to the board's own log. This lets the
// installed GoWild app notify for itself, so the app is the only face.
//
// Two properties matter more than the code:
//   1. Nothing is delivered in the clear. The payload is encrypted to the device's own
//      key, so a URL carrying the board token can ride inside it (ntfy's cache was the
//      reason a token could never be put in a notification before).
//   2. A dead subscription is a 404/410, and it must be deleted rather than retried
//      forever: a push service answering 410 is telling us to forget the device.

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toB64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const a = b[i];
    const c = i + 1 < b.length ? b[i + 1] : 0;
    const d = i + 2 < b.length ? b[i + 2] : 0;
    out += B64U[a >> 2];
    out += B64U[((a & 3) << 4) | (c >> 4)];
    if (i + 1 < b.length) out += B64U[((c & 15) << 2) | (d >> 6)];
    if (i + 2 < b.length) out += B64U[d & 63];
  }
  return out;
}

export function fromB64u(s) {
  const clean = String(s || '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const idx = B64U.indexOf(clean[i]);
    if (idx < 0) continue;
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (value >> bits) & 255;
      at += 1;
    }
  }
  return out.subarray(0, at);
}

const enc = new TextEncoder();

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(ikm, salt, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

// The public key is what the browser subscribes with, so it has to be readable by the
// page. The private half never leaves the Worker.
export function publicKey(env) {
  const raw = env && env.VAPID_PUBLIC;
  if (!raw) return null;
  const bytes = fromB64u(raw);
  return bytes.length === 65 ? bytes : null;
}

async function vapidHeaders(endpoint, env, now) {
  const pub = publicKey(env);
  if (!pub || !env.VAPID_PRIVATE) throw new Error('VAPID keys are not set');
  const aud = new URL(endpoint).origin;
  const header = toB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toB64u(
    enc.encode(
      JSON.stringify({
        aud,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: env.VAPID_SUBJECT || 'mailto:gowild-board@users.noreply.github.com',
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  const priv = fromB64u(env.VAPID_PRIVATE);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: toB64u(priv),
    x: toB64u(pub.subarray(1, 33)),
    y: toB64u(pub.subarray(33, 65)),
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return {
    Authorization: `vapid t=${unsigned}.${toB64u(sig)}, k=${toB64u(pub)}`,
  };
}

// RFC 8291 section 3.4, then RFC 8188's single-record framing.
export async function encryptPayload(payload, p256dh, auth, salt = null) {
  const uaPub = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPub.length !== 65) throw new Error('bad p256dh length');
  if (!authSecret.length) throw new Error('missing auth secret');
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPub, asPub);
  const ikm = await hkdf(shared, authSecret, keyInfo, 32);
  const s = salt || crypto.getRandomValues(new Uint8Array(16));
  // The info is the label followed by ONE zero octet. The trailing 0x01 of RFC 8188's
  // HKDF-Expand(info, L) is the block counter, and WebCrypto appends it itself -- adding
  // it here produced a key Chrome could not decrypt, and Chrome drops such a message
  // without a word: measured on the S23, 2026-11-13, where a payload push vanished and a
  // body-less push to the same subscription arrived normally.
  const cek = await hkdf(ikm, s, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, s, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintext = concat(enc.encode(JSON.stringify(payload)), new Uint8Array([2]));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, plaintext),
  );
  const rs = 4096;
  const header = concat(
    s,
    new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]),
    new Uint8Array([asPub.length]),
    asPub,
  );
  return concat(header, ct);
}

// Returns a reason rather than throwing: a notification channel must never be able to
// take down the write path that produced the update.
export async function sendPush(sub, payload, env, now = Date.now()) {
  if (!sub || !sub.endpoint || !sub.keys) return { ok: false, reason: 'subscription has no endpoint or keys' };
  if (!publicKey(env) || !env.VAPID_PRIVATE) return { ok: false, reason: 'VAPID keys are not set' };
  try {
    const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
    const auth = await vapidHeaders(sub.endpoint, env, now);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: payload.urgency || 'normal',
      },
      body,
    });
    if (res.status === 201 || res.status === 200 || res.status === 202) {
      return { ok: true, status: res.status };
    }
    const gone = res.status === 404 || res.status === 410;
    return { ok: false, status: res.status, gone, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 120) };
  }
}

// A push with no body at all. Used only to separate two failures that look identical
// from the Worker: "FCM never delivered" and "Chrome delivered something it could not
// decrypt". With an empty push the service worker still fires, with a null payload.
export async function sendEmpty(sub, env, now = Date.now()) {
  if (!sub || !sub.endpoint) return { ok: false, reason: 'no endpoint' };
  try {
    const auth = await vapidHeaders(sub.endpoint, env, now);
    const res = await fetch(sub.endpoint, { method: 'POST', headers: { ...auth, TTL: '86400', Urgency: 'high' } });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 120) };
  }
}

// --- Subscriptions ------------------------------------------------------------

export const PUSH_PREFIX = 'push:';

async function endpointId(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(endpoint)));
  return toB64u(new Uint8Array(digest)).slice(0, 22);
}

export async function saveSubscription(env, body, meta, now = Date.now()) {
  const endpoint = body && body.endpoint;
  const keys = body && body.keys;
  if (!endpoint || typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) {
    return { ok: false, reason: 'endpoint must be an https URL' };
  }
  if (!keys || !keys.p256dh || !keys.auth) return { ok: false, reason: 'keys.p256dh and keys.auth are required' };
  if (fromB64u(keys.p256dh).length !== 65) return { ok: false, reason: 'p256dh is not a P-256 point' };
  const record = {
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    profile: (meta && meta.profile) || 'rdu',
    label: (meta && meta.label) || '',
    at: (meta && meta.at) || now,
    lastOk: null,
    lastError: null,
  };
  const id = await endpointId(endpoint);
  const prev = await env.BOARD.get(`${PUSH_PREFIX}${id}`, 'json').catch(() => null);
  if (prev && prev.at) record.at = prev.at;
  await env.BOARD.put(`${PUSH_PREFIX}${id}`, JSON.stringify(record));
  return { ok: true, id, count: (await listSubscriptions(env)).length };
}

export async function listSubscriptions(env, profile = null) {
  const out = [];
  let cursor = undefined;
  for (let page = 0; page < 10; page += 1) {
    const listed = await env.BOARD.list({ prefix: PUSH_PREFIX, cursor });
    for (const k of listed.keys) {
      const rec = await env.BOARD.get(k.name, 'json').catch(() => null);
      if (rec && rec.endpoint && (!profile || rec.profile === profile)) out.push({ id: k.name.slice(PUSH_PREFIX.length), ...rec });
    }
    if (listed.list_complete) break;
    cursor = listed.cursor;
  }
  return out;
}

export async function dropSubscription(env, id) {
  await env.BOARD.delete(`${PUSH_PREFIX}${id}`);
}

// One update, every device. A 404/410 removes the device instead of remembering it:
// keeping it would mean a delivery that can never succeed, reported as a failure
// forever, which is the silent-failure shape this project exists to avoid.
export async function sendToAll(env, subs, payload, now = Date.now()) {
  const sent = [];
  const failed = [];
  for (const sub of subs) {
    const res = await sendPush(sub, payload, env, now);
    if (res.ok) {
      sent.push(sub.id);
      await env.BOARD
        .put(`${PUSH_PREFIX}${sub.id}`, JSON.stringify({ ...sub, lastOk: now, lastError: null }))
        .catch(() => {});
    } else {
      failed.push({ id: sub.id, reason: res.reason });
      if (res.gone) await dropSubscription(env, sub.id).catch(() => {});
      else
        await env.BOARD
          .put(`${PUSH_PREFIX}${sub.id}`, JSON.stringify({ ...sub, lastError: `${res.reason} at ${new Date(now).toISOString()}` }))
          .catch(() => {});
    }
  }
  return { sent, failed };
}
