import { parseFlac, MetadataBlockType } from './flac';

// ════════════════════════════════════════════════════════════════════════════
// OGG OPUS ENCODER E MUXER (WEBCODECS NATIVO)
// ════════════════════════════════════════════════════════════════════════════

let crcTable: Uint32Array | null = null;

/**
 * Calcula a soma de verificação CRC32 (especificação Ogg)
 */
function oggCrc(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) {
        r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
        r >>>= 0;
      }
      crcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ data[i]) & 0xFF]) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Converte um Uint8Array contendo dados binários em uma string codificada em Base64
 */
function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = '';
  const len = arr.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

/**
 * Cria páginas Ogg envolvendo um pacote de dados (payload)
 * Divide o pacote em múltiplas páginas se exceder 65KB (255 * 255 bytes)
 */
function createOggPages(
  packet: Uint8Array,
  serial: number,
  startSeq: number,
  granule: bigint,
  initialFlags: number
): { pages: Uint8Array[], nextSeq: number } {
  const MAX_PAGE_PAYLOAD = 65025; // 255 * 255
  const pages: Uint8Array[] = [];
  let offset = 0;
  let seq = startSeq;

  while (offset < packet.length || (packet.length === 0 && offset === 0)) {
    const isFirstPage = offset === 0;
    const remaining = packet.length - offset;
    const chunkLength = Math.min(MAX_PAGE_PAYLOAD, remaining);
    const chunk = packet.subarray(offset, offset + chunkLength);

    // Flag de continuação (0x01) para páginas adicionais do mesmo pacote
    let pageFlags = isFirstPage ? initialFlags : 0x01;
    if (!isFirstPage && (initialFlags & 0x04)) {
      // O bit de EOS (fim de fluxo) só vai na última página do pacote
      if (offset + chunkLength === packet.length) {
        pageFlags |= 0x04;
      }
    }

    const segs: number[] = [];
    let rem = chunk.length;
    while (rem >= 255) {
      segs.push(255);
      rem -= 255;
    }
    segs.push(rem);

    // Se o pacote terminar exatamente em múltiplo de 255, adicionamos um segmento 0 final para sinalizar encerramento
    if (offset + chunk.length === packet.length && rem === 0) {
      segs.push(0);
    }

    const hdrLen = 27 + segs.length;
    const page = new Uint8Array(hdrLen + chunk.length);
    const dv = new DataView(page.buffer);

    // "OggS"
    page[0] = 0x4F; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53;
    page[4] = 0; // versão Ogg
    page[5] = pageFlags;

    // Granule position
    dv.setUint32(6, Number(granule & 0xFFFFFFFFn), true);
    dv.setUint32(10, Number((granule >> 32n) & 0xFFFFFFFFn), true);

    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq++, true);
    dv.setUint32(22, 0, true); // CRC placeholder

    page[26] = segs.length;
    for (let i = 0; i < segs.length; i++) {
      page[27 + i] = segs[i];
    }
    page.set(chunk, hdrLen);

    dv.setUint32(22, oggCrc(page), true);
    pages.push(page);

    offset += chunkLength;
    if (packet.length === 0) break;
  }

  return { pages, nextSeq: seq };
}

/**
 * Cria o pacote de identificação OpusHead (RFC 7845)
 */
function createOpusHead(channels: number, preSkip: number, inputRate: number): Uint8Array {
  const b = new Uint8Array(19);
  const d = new DataView(b.buffer);
  
  const magic = "OpusHead";
  for (let i = 0; i < magic.length; i++) {
    b[i] = magic.charCodeAt(i);
  }
  b[8] = 1; // versão
  b[9] = channels;
  d.setUint16(10, preSkip, true);
  d.setUint32(12, inputRate, true);
  d.setInt16(16, 0, true); // ganho de saída
  b[18] = 0; // mapeamento de canais família 0
  return b;
}

/**
 * Cria o pacote de comentários Vorbis OpusTags (RFC 7845)
 */
function createOpusTags(metadata: Map<string, string>): Uint8Array {
  const vendor = "FLAC Lyrics Embedder WebCodecs Encoder";
  const vendorBytes = new TextEncoder().encode(vendor);

  const commentBytesList: Uint8Array[] = [];
  let totalCommentsLength = 0;

  for (const [key, val] of metadata) {
    if (val && String(val).trim()) {
      const commentStr = `${key.toUpperCase()}=${val}`;
      const commentBytes = new TextEncoder().encode(commentStr);
      commentBytesList.push(commentBytes);
      totalCommentsLength += 4 + commentBytes.length;
    }
  }

  const totalLength = 8 + 4 + vendorBytes.length + 4 + totalCommentsLength;
  const b = new Uint8Array(totalLength);
  const d = new DataView(b.buffer);

  const magic = "OpusTags";
  for (let i = 0; i < magic.length; i++) {
    b[i] = magic.charCodeAt(i);
  }

  let offset = 8;
  d.setUint32(offset, vendorBytes.length, true);
  offset += 4;
  b.set(vendorBytes, offset);
  offset += vendorBytes.length;

  d.setUint32(offset, commentBytesList.length, true);
  offset += 4;

  for (const commentBytes of commentBytesList) {
    d.setUint32(offset, commentBytes.length, true);
    offset += 4;
    b.set(commentBytes, offset);
    offset += commentBytes.length;
  }

  return b;
}

/**
 * Junta múltiplas arrays de bytes em uma só
 */
function concat(arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Verifica se a API WebCodecs e o codec Opus são suportados no navegador atual
 */
export function isOpusEncodingSupported(): boolean {
  return typeof window.AudioEncoder !== 'undefined';
}

let sharedAudioCtx: AudioContext | null = null;

function getSharedAudioCtx(): AudioContext {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
  }
  return sharedAudioCtx;
}

/**
 * Transcodifica um buffer de arquivo FLAC para um Ogg Opus com metadados embutidos
 */
export async function encodeFlacToOpus(
  flacBuffer: ArrayBuffer,
  metadata: Map<string, string>,
  onProgress?: (pct: number) => void
): Promise<Uint8Array> {
  if (!isOpusEncodingSupported()) {
    throw new Error("A codificação de áudio via WebCodecs (Opus) não é suportada por este navegador.");
  }

  // 1. Extrair imagem de capa do FLAC se existir e embuti-la como METADATA_BLOCK_PICTURE
  try {
    const flacInfo = parseFlac(flacBuffer);
    const pictureBlock = flacInfo.metadataBlocks.find(b => b.type === MetadataBlockType.PICTURE);
    if (pictureBlock) {
      const base64Pic = uint8ArrayToBase64(pictureBlock.data);
      metadata.set('METADATA_BLOCK_PICTURE', base64Pic);
    }
  } catch (e) {
    console.warn("Falha ao ler bloco de imagens do FLAC:", e);
  }

  // 2. Decodificar o áudio FLAC para PCM a 48kHz usando um AudioContext compartilhado
  const audioCtx = getSharedAudioCtx();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  const audioBuffer = await audioCtx.decodeAudioData(flacBuffer.slice(0));

  const channels = audioBuffer.numberOfChannels;
  const encChannels = Math.min(2, channels);
  const totalFrames = audioBuffer.length;
  
  return new Promise<Uint8Array>(async (resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let pageSeq = 0;
    let granule = 0n;
    const PRE_SKIP = 3840;
    const serial = Math.floor(Math.random() * 0xFFFFFFFF);
    let encoder: AudioEncoder | null = null;

    try {
      // 3. Gravar os cabeçalhos iniciais do Ogg (BOS e Tags) com suporte a paginação de pacotes grandes
      const headRes = createOggPages(createOpusHead(encChannels, PRE_SKIP, 48000), serial, pageSeq, 0n, 0x02);
      chunks.push(...headRes.pages);
      pageSeq = headRes.nextSeq;

      const tagsRes = createOggPages(createOpusTags(metadata), serial, pageSeq, 0n, 0x00);
      chunks.push(...tagsRes.pages);
      pageSeq = tagsRes.nextSeq;

      // 4. Inicializar e configurar o codificador
      encoder = new AudioEncoder({
        output: (chunk) => {
          const payload = new Uint8Array(chunk.byteLength);
          chunk.copyTo(payload);
          
          const durationUs = chunk.duration || 20000;
          const samples = BigInt(Math.round(durationUs * 0.048));
          granule += samples;

          // Cria página Ogg para este quadro de áudio
          const res = createOggPages(payload, serial, pageSeq, granule, 0x00);
          chunks.push(...res.pages);
          pageSeq = res.nextSeq;
        },
        error: (err) => {
          console.error("Erro no AudioEncoder:", err);
          if (encoder) {
            try { encoder.close(); } catch (_) {}
            encoder = null;
          }
          reject(err);
        }
      });

      encoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: encChannels,
        bitrate: 192000, // 192kbps
      });

      // 5. Enviar os dados de áudio em pedaços de 1 segundo para o codificador
      const chunkSize = 48000;
      let offset = 0;

      while (offset < totalFrames) {
        const framesToProcess = Math.min(chunkSize, totalFrames - offset);
        
        const planarBuffer = new Float32Array(framesToProcess * encChannels);
        for (let c = 0; c < encChannels; c++) {
          const channelData = audioBuffer.getChannelData(c);
          const slice = channelData.subarray(offset, offset + framesToProcess);
          planarBuffer.set(slice, c * framesToProcess);
        }

        const timestamp = offset * (1000000 / 48000);

        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: 48000,
          numberOfFrames: framesToProcess,
          numberOfChannels: encChannels,
          timestamp: timestamp,
          data: planarBuffer,
        });

        encoder.encode(audioData);
        audioData.close();

        // Controlar o tamanho da fila de codificação para evitar estouro de memória e corrupção
        if (encoder.encodeQueueSize > 5) {
          await new Promise<void>((r) => {
            const onDequeue = () => {
              if (encoder && encoder.encodeQueueSize <= 5) {
                encoder.removeEventListener('dequeue', onDequeue);
                r();
              }
            };
            if (encoder) {
              encoder.addEventListener('dequeue', onDequeue);
            } else {
              r();
            }
          });
        }

        offset += framesToProcess;
        if (onProgress) {
          onProgress(Math.min(99, Math.round((offset / totalFrames) * 100)));
        }
      }

      // 6. Finalizar a codificação
      await encoder.flush();
      encoder.close();
      encoder = null;

      // 7. Marcar a última página de áudio com a flag EOS (End of Stream) e recalcular o CRC
      if (chunks.length > 2) {
        const lastPage = chunks[chunks.length - 1];
        lastPage[5] |= 0x04; // EOS flag
        
        const dv = new DataView(lastPage.buffer, lastPage.byteOffset, lastPage.byteLength);
        dv.setUint32(22, 0, true);
        dv.setUint32(22, oggCrc(lastPage), true);
      }

      if (onProgress) {
        onProgress(100);
      }

      resolve(concat(chunks));
    } catch (e) {
      if (encoder) {
        try { encoder.close(); } catch (_) {}
        encoder = null;
      }
      reject(e);
    }
  });
}
