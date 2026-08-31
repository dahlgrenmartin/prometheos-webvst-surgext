import { inflateRawSync } from "node:zlib";

/**
 * A minimal, independent reader for the `.webvst` container.
 *
 * `tests/package.test.ts` and `tests/real_engine.test.ts` both need the raw
 * bytes of individual archive entries -- the manifest, the module, a preset
 * slice -- and the SDK's own archive module exposes only whole-archive
 * verification (`verifyWebVst`), never the entry payloads. Reading the ZIP
 * central directory here keeps the acceptance tests from depending on SDK
 * internals, and means a container the SDK writes is decoded by something
 * other than the code that wrote it.
 *
 * Deliberately strict but small: it understands exactly what the SDK's packer
 * emits (stored or raw-deflated entries, no ZIP64, no encryption) and throws
 * on anything else rather than guessing. Integrity checks (CRC, hashes, path
 * safety, the ABI probe) are the SDK verifier's job and are asserted through
 * it, not re-implemented here.
 */

const EOCD_SIGNATURE = 0x0605_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const LOCAL_SIGNATURE = 0x0403_4b50;
const MAX_EOCD_SEARCH = 65_557;

function fail(message: string): never {
  throw new Error(`webvst archive reader: ${message}`);
}

function findEndOfCentralDirectory(view: Buffer): number {
  const start = Math.max(0, view.length - MAX_EOCD_SEARCH);
  for (let offset = view.length - 22; offset >= start; offset -= 1) {
    if (view.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  fail("missing ZIP end-of-central-directory record");
}

/**
 * Every entry in the archive, keyed by its archive-relative POSIX path, in
 * central-directory order (which is the packer's sorted name order).
 */
export function readArchiveEntries(archive: Uint8Array): Map<string, Uint8Array> {
  const view = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.readUInt16LE(eocd + 10);
  let offset = view.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffff_ffff) fail("ZIP64 archives are not supported");

  const entries = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    if (view.readUInt32LE(offset) !== CENTRAL_SIGNATURE) fail(`invalid central directory entry ${index}`);
    const flags = view.readUInt16LE(offset + 8);
    const method = view.readUInt16LE(offset + 10);
    const compressedSize = view.readUInt32LE(offset + 20);
    const expandedSize = view.readUInt32LE(offset + 24);
    const nameLength = view.readUInt16LE(offset + 28);
    const extraLength = view.readUInt16LE(offset + 30);
    const commentLength = view.readUInt16LE(offset + 32);
    const localOffset = view.readUInt32LE(offset + 42);
    if (flags & 1) fail("encrypted ZIP entries are not supported");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      view.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (entries.has(name)) fail(`duplicate entry name ${name}`);

    if (view.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) fail(`invalid local entry ${name}`);
    const localNameLength = view.readUInt16LE(localOffset + 26);
    const localExtraLength = view.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = view.subarray(dataOffset, dataOffset + compressedSize);
    const data =
      method === 0
        ? new Uint8Array(compressed)
        : method === 8
          ? new Uint8Array(inflateRawSync(compressed))
          : fail(`unsupported compression method ${method} for ${name}`);
    if (data.byteLength !== expandedSize) fail(`expanded size mismatch for ${name}`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
