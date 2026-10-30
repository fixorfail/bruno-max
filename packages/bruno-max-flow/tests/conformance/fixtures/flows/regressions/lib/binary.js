// Helpers for a flow that reads a binary response through `res.base64` (001 §8.2).
//
// They use only what the QuickJS sandbox has: `Uint8Array`, `DataView` and `String.fromCharCode`.
// QuickJS has no `atob`, no `TextDecoder` and no `Buffer`, so this file brings its own decoders.
// The ZIP reader reads stored entries only. A flow that downloads a deflated ZIP must also bring
// an inflate helper.

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(text) {
  const clean = text.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let position = 0; position < clean.length; position += 1) {
    const value = BASE64_ALPHABET.indexOf(clean[position]);
    if (value < 0) throw new Error(`not base64 at position ${position}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return bytes;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let index = 0; index < bytes.length; index += 1) hex += bytes[index].toString(16).padStart(2, '0');
  return hex;
}

function utf8Decode(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 1) text += `%${bytes[index].toString(16).padStart(2, '0')}`;
  return decodeURIComponent(text);
}

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a ZIP file: no end of central directory');

  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = [];
  for (let entry = 0; entry < count; entry += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = utf8Decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.push({ name, method, data: bytes.subarray(start, start + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipText(bytes, suffix) {
  const entry = zipEntries(bytes).find((candidate) => candidate.name.endsWith(suffix));
  if (!entry) throw new Error(`the ZIP has no entry that ends with ${suffix}`);
  if (entry.method !== 0) throw new Error(`${entry.name} is compressed (method ${entry.method}); bring an inflate helper`);
  return utf8Decode(entry.data);
}

function parseCsv(text) {
  const [header, ...rows] = text.trim().split('\n');
  const columns = header.split(',');
  return rows.map((row) => Object.fromEntries(row.split(',').map((cell, index) => [columns[index], cell])));
}
