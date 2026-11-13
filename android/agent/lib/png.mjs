// Capture validation.
//
// Measured on the S23 (2026-11-13), and this is the reason the file exists:
//
//   adb exec-out screencap -d 0 -p     -> exit code 0, 79 bytes, and the bytes are
//                                         the TEXT "Failed to take screenshot.
//                                         Display Id '0' is not valid. Capturing
//                                         failed." — not a PNG at all.
//
// So exit status is worthless here and the byte count is the only signal. A stub is
// 79-82 bytes; a real 720x1280 overlay capture is ~413 KB. Everything below refuses
// to call a capture valid unless the signature, the size, the IHDR geometry and
// (when known) the expected display geometry all agree.

export const CAPTURE_FLOOR_BYTES = 2048;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class CaptureFailure extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'CaptureFailure';
    this.detail = detail;
  }
}

export function inspectPng(buf, { expected = null, floorBytes = CAPTURE_FLOOR_BYTES } = {}) {
  const bytes = buf ? buf.length : 0;
  if (!buf || bytes === 0) return { ok: false, reason: 'empty', bytes };

  const signatureOk = bytes >= 8 && SIGNATURE.every((byte, index) => buf[index] === byte);
  if (!signatureOk) {
    return {
      ok: false,
      reason: 'not-a-png',
      bytes,
      text: buf.toString('utf8', 0, Math.min(bytes, 300)).replace(/\s+/g, ' ').trim(),
    };
  }
  if (bytes < floorBytes) return { ok: false, reason: 'stub-size', bytes, floorBytes };
  if (bytes < 33 || buf.toString('ascii', 12, 16) !== 'IHDR') return { ok: false, reason: 'no-ihdr', bytes };

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!(width >= 200 && height >= 200)) {
    return { ok: false, reason: 'implausible-geometry', bytes, width, height };
  }
  if (expected && (width !== expected.width || height !== expected.height)) {
    return { ok: false, reason: 'geometry-mismatch', bytes, width, height, expected };
  }
  return { ok: true, reason: 'ok', bytes, width, height };
}

export function describeCaptureFailure(info) {
  if (!info) return 'capture failed with no diagnostics';
  const said = info.text ? ` screencap said: "${info.text}"` : '';
  switch (info.reason) {
    case 'not-a-png':
      return `capture is not a PNG (${info.bytes} bytes).${said}`;
    case 'stub-size':
      return `capture is a ${info.bytes}-byte stub (floor ${info.floorBytes}).${said}`;
    case 'implausible-geometry':
      return `capture is ${info.width}x${info.height}, which cannot be a device display.`;
    case 'geometry-mismatch':
      return `capture is ${info.width}x${info.height}, expected ${info.expected.width}x${info.expected.height}.`;
    case 'empty':
      return 'capture returned no bytes at all.';
    default:
      return `capture failed: ${info.reason}.${said}`;
  }
}
