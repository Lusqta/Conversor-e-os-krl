// ─── Types ────────────────────────────────────────────────────────────────────

export const MetadataBlockType = {
  STREAMINFO:     0,
  PADDING:        1,
  APPLICATION:    2,
  SEEKTABLE:      3,
  VORBIS_COMMENT: 4,
  CUESHEET:       5,
  PICTURE:        6,
} as const;

export type MetadataBlockType = (typeof MetadataBlockType)[keyof typeof MetadataBlockType];

export interface MetadataBlock {
  type: MetadataBlockType;
  isLast: boolean;
  /** Raw block payload (excludes the 4‑byte header). */
  data: Uint8Array;
}

export interface VorbisComment {
  vendor: string;
  comments: Map<string, string>;
}

export interface FlacFile {
  /** All metadata blocks in order. */
  metadataBlocks: MetadataBlock[];
  /** Offset (in bytes) where the first audio frame begins. */
  audioOffset: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FLAC_MAGIC = 0x664C6143; // 'fLaC' as a 32‑bit big‑endian value
const METADATA_BLOCK_HEADER_SIZE = 4;

// ─── Codec helpers ────────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a FLAC file from a raw `ArrayBuffer`.
 *
 * @throws {Error} if the stream marker is missing or truncated.
 */
export function parseFlac(buffer: ArrayBuffer): FlacFile {
  const view = new DataView(buffer);

  // ── 1. Verify the 'fLaC' stream marker ──────────────────────────────────
  if (buffer.byteLength < 4) {
    throw new Error('Buffer is too small to be a valid FLAC file');
  }
  if (view.getUint32(0, false) !== FLAC_MAGIC) {
    throw new Error('Missing FLAC stream marker (expected "fLaC")');
  }

  // ── 2. Walk metadata blocks ─────────────────────────────────────────────
  const metadataBlocks: MetadataBlock[] = [];
  let offset = 4; // right after the marker

  let lastBlockSeen = false;
  while (!lastBlockSeen) {
    if (offset + METADATA_BLOCK_HEADER_SIZE > buffer.byteLength) {
      throw new Error(`Unexpected end of file at offset ${offset}`);
    }

    const headerByte = view.getUint8(offset);
    const isLast = (headerByte & 0x80) !== 0;
    const type: MetadataBlockType = (headerByte & 0x7f) as MetadataBlockType;

    // 24‑bit big‑endian length stored across bytes 1–3
    const length =
      (view.getUint8(offset + 1) << 16) |
      (view.getUint8(offset + 2) << 8) |
      view.getUint8(offset + 3);

    const dataStart = offset + METADATA_BLOCK_HEADER_SIZE;
    if (dataStart + length > buffer.byteLength) {
      throw new Error(
        `Metadata block at offset ${offset} claims ${length} bytes but file is too short`,
      );
    }

    metadataBlocks.push({
      type,
      isLast,
      data: new Uint8Array(buffer, dataStart, length),
    });

    offset = dataStart + length;
    lastBlockSeen = isLast;
  }

  return { metadataBlocks, audioOffset: offset };
}

// ─── Vorbis Comment codec ─────────────────────────────────────────────────────

/**
 * Decode a VORBIS_COMMENT metadata block into structured data.
 *
 * Field names are normalised to **uppercase** for consistency with the Vorbis
 * specification recommendation.
 */
export function parseVorbisComment(data: Uint8Array): VorbisComment {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;

  // Vendor string
  const vendorLen = view.getUint32(pos, true);
  pos += 4;
  const vendor = textDecoder.decode(data.subarray(pos, pos + vendorLen));
  pos += vendorLen;

  // User comments
  const commentCount = view.getUint32(pos, true);
  pos += 4;

  const comments = new Map<string, string>();

  for (let i = 0; i < commentCount; i++) {
    const commentLen = view.getUint32(pos, true);
    pos += 4;
    const raw = textDecoder.decode(data.subarray(pos, pos + commentLen));
    pos += commentLen;

    const eqIndex = raw.indexOf('=');
    if (eqIndex !== -1) {
      const key = raw.substring(0, eqIndex).toUpperCase();
      const value = raw.substring(eqIndex + 1);
      comments.set(key, value);
    }
  }

  return { vendor, comments };
}

/**
 * Encode a `VorbisComment` back into its binary representation.
 */
export function encodeVorbisComment(vc: VorbisComment): Uint8Array {
  const vendorBytes = textEncoder.encode(vc.vendor);

  // Pre‑encode every comment string so we can compute the total size.
  const encodedComments: Uint8Array[] = [];
  for (const [key, value] of vc.comments) {
    encodedComments.push(textEncoder.encode(`${key}=${value}`));
  }

  // Total size = vendorLen(4) + vendor + commentCount(4) + Σ(commentLen(4) + comment)
  let totalSize = 4 + vendorBytes.length + 4;
  for (const ec of encodedComments) {
    totalSize += 4 + ec.length;
  }

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let pos = 0;

  // Vendor
  view.setUint32(pos, vendorBytes.length, true);
  pos += 4;
  out.set(vendorBytes, pos);
  pos += vendorBytes.length;

  // Comments
  view.setUint32(pos, encodedComments.length, true);
  pos += 4;
  for (const ec of encodedComments) {
    view.setUint32(pos, ec.length, true);
    pos += 4;
    out.set(ec, pos);
    pos += ec.length;
  }

  return out;
}

// ─── File reconstruction ──────────────────────────────────────────────────────

/**
 * Rebuild a full FLAC file from metadata blocks and the original audio frames.
 */
function reconstructFlac(
  metadataBlocks: MetadataBlock[],
  audioData: Uint8Array,
): ArrayBuffer {
  // Calculate total metadata size
  let metaSize = 4; // 'fLaC' marker
  for (const block of metadataBlocks) {
    metaSize += METADATA_BLOCK_HEADER_SIZE + block.data.byteLength;
  }

  const totalSize = metaSize + audioData.byteLength;
  const out = new ArrayBuffer(totalSize);
  const outView = new DataView(out);
  const outBytes = new Uint8Array(out);
  let pos = 0;

  // Stream marker
  outView.setUint32(pos, FLAC_MAGIC, false);
  pos += 4;

  // Metadata blocks
  for (let i = 0; i < metadataBlocks.length; i++) {
    const block = metadataBlocks[i];
    const isLast = i === metadataBlocks.length - 1;

    // Header byte: isLast flag | block type
    outBytes[pos] = (isLast ? 0x80 : 0x00) | (block.type & 0x7f);
    pos += 1;

    // 24‑bit big‑endian length
    const len = block.data.byteLength;
    outBytes[pos]     = (len >>> 16) & 0xff;
    outBytes[pos + 1] = (len >>> 8) & 0xff;
    outBytes[pos + 2] = len & 0xff;
    pos += 3;

    // Block data
    outBytes.set(block.data, pos);
    pos += len;
  }

  // Audio frames
  outBytes.set(audioData, pos);

  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Embed (or replace) a `LYRICS` Vorbis comment tag inside a FLAC file.
 *
 * If no VORBIS_COMMENT block exists yet one is created with an empty vendor
 * string. The returned `ArrayBuffer` is a brand‑new copy of the file with the
 * updated metadata.
 */
export function embedLyrics(
  flacBuffer: ArrayBuffer,
  lyricsText: string,
): ArrayBuffer {
  const flac = parseFlac(flacBuffer);

  // Grab the raw audio frames (everything after the last metadata block).
  const audioData = new Uint8Array(flacBuffer, flac.audioOffset);

  // ── Locate or create the Vorbis Comment block ───────────────────────────
  let vcBlockIndex = flac.metadataBlocks.findIndex(
    (b) => b.type === MetadataBlockType.VORBIS_COMMENT,
  );

  let vc: VorbisComment;

  if (vcBlockIndex !== -1) {
    vc = parseVorbisComment(flac.metadataBlocks[vcBlockIndex].data);
  } else {
    // Create a minimal Vorbis Comment block.
    vc = { vendor: '', comments: new Map() };

    // Insert right after STREAMINFO (index 0) when possible.
    vcBlockIndex = flac.metadataBlocks.length > 0 ? 1 : 0;
  }

  // ── Set the LYRICS tag ──────────────────────────────────────────────────
  vc.comments.set('LYRICS', lyricsText);

  const newVcData = encodeVorbisComment(vc);
  const newBlock: MetadataBlock = {
    type: MetadataBlockType.VORBIS_COMMENT,
    isLast: false, // reconstructFlac will recalculate this
    data: newVcData,
  };

  // Replace existing or insert new block.
  if (
    flac.metadataBlocks.some(
      (b) => b.type === MetadataBlockType.VORBIS_COMMENT,
    )
  ) {
    flac.metadataBlocks[vcBlockIndex] = newBlock;
  } else {
    flac.metadataBlocks.splice(vcBlockIndex, 0, newBlock);
  }

  return reconstructFlac(flac.metadataBlocks, audioData);
}

/**
 * Returns `true` when the FLAC file contains a VORBIS_COMMENT block with a
 * `LYRICS` tag (case‑insensitive key comparison).
 */
export function hasLyrics(flacBuffer: ArrayBuffer): boolean {
  const flac = parseFlac(flacBuffer);

  const vcBlock = flac.metadataBlocks.find(
    (b) => b.type === MetadataBlockType.VORBIS_COMMENT,
  );
  if (!vcBlock) return false;

  const vc = parseVorbisComment(vcBlock.data);
  return vc.comments.has('LYRICS');
}

/**
 * Update general Vorbis comment metadata of a FLAC file.
 * `updates` is a Map of tags (key) and values to set. If a value is null or undefined, the tag is deleted.
 */
export function updateFlacMetadata(
  buffer: ArrayBuffer,
  updates: Map<string, string | null>,
): ArrayBuffer {
  const flac = parseFlac(buffer);
  const audioData = new Uint8Array(buffer, flac.audioOffset);

  let vcBlockIndex = flac.metadataBlocks.findIndex(
    (b) => b.type === MetadataBlockType.VORBIS_COMMENT,
  );

  let vc: VorbisComment;

  if (vcBlockIndex !== -1) {
    vc = parseVorbisComment(flac.metadataBlocks[vcBlockIndex].data);
  } else {
    vc = { vendor: 'FLAC Lyrics Embedder', comments: new Map() };
    vcBlockIndex = flac.metadataBlocks.length > 0 ? 1 : 0;
  }

  for (const [key, val] of updates) {
    const uppercaseKey = key.toUpperCase();
    if (val === null || val === undefined) {
      vc.comments.delete(uppercaseKey);
    } else {
      vc.comments.set(uppercaseKey, val);
    }
  }

  const newVcData = encodeVorbisComment(vc);
  const newBlock: MetadataBlock = {
    type: MetadataBlockType.VORBIS_COMMENT,
    isLast: false,
    data: newVcData,
  };

  if (
    flac.metadataBlocks.some(
      (b) => b.type === MetadataBlockType.VORBIS_COMMENT,
    )
  ) {
    flac.metadataBlocks[vcBlockIndex] = newBlock;
  } else {
    flac.metadataBlocks.splice(vcBlockIndex, 0, newBlock);
  }

  return reconstructFlac(flac.metadataBlocks, audioData);
}

/**
 * Extract lyrics from FLAC file. Looks for LYRICS, UNSYNCEDLYRICS, or SYNCEDLYRICS.
 */
export function extractLyricsFromBuffer(
  buffer: ArrayBuffer,
): { tag: string; lyrics: string } | null {
  const flac = parseFlac(buffer);
  const vcBlock = flac.metadataBlocks.find(
    (b) => b.type === MetadataBlockType.VORBIS_COMMENT,
  );
  if (!vcBlock) return null;

  const vc = parseVorbisComment(vcBlock.data);
  for (const tag of ['LYRICS', 'UNSYNCEDLYRICS', 'SYNCEDLYRICS']) {
    if (vc.comments.has(tag)) {
      return { tag, lyrics: vc.comments.get(tag)! };
    }
  }
  return null;
}

/**
 * Read all metadata tags from VORBIS_COMMENT in FLAC.
 */
export function readFlacMetadata(buffer: ArrayBuffer): Map<string, string> {
  const flac = parseFlac(buffer);
  const vcBlock = flac.metadataBlocks.find(
    (b) => b.type === MetadataBlockType.VORBIS_COMMENT,
  );
  if (!vcBlock) return new Map();

  const vc = parseVorbisComment(vcBlock.data);
  return vc.comments;
}

/**
 * Extract album cover picture data from FLAC PICTURE metadata block and return an Object URL.
 */
export function extractCoverUrl(pictureDataBlock: Uint8Array): { mime: string; url: string } | null {
  try {
    const view = new DataView(pictureDataBlock.buffer, pictureDataBlock.byteOffset, pictureDataBlock.byteLength);
    const mimeLen = view.getUint32(4, false);
    const mimeBytes = pictureDataBlock.subarray(8, 8 + mimeLen);
    const mime = new TextDecoder('ascii').decode(mimeBytes);
    
    const descLen = view.getUint32(8 + mimeLen, false);
    
    const dataLenOffset = 8 + mimeLen + 4 + descLen + 16;
    const dataLen = view.getUint32(dataLenOffset, false);
    const dataOffset = dataLenOffset + 4;
    
    const rawData = pictureDataBlock.subarray(dataOffset, dataOffset + dataLen);
    const blob = new Blob([rawData as any], { type: mime });
    const url = URL.createObjectURL(blob);
    return { mime, url };
  } catch (e) {
    console.warn("Falha ao extrair capa do FLAC:", e);
    return null;
  }
}

