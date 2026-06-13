import './style.css';
import JSZip from 'jszip';
import {
  readFlacMetadata,
  updateFlacMetadata,
  extractLyricsFromBuffer,
  parseFlac,
  extractCoverUrl,
  MetadataBlockType,
} from './flac';
import { encodeFlacToOpus, isOpusEncodingSupported } from './opus';
import { getTranslation } from './i18n';
import type { LangCode } from './i18n';

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 1: TIPAGEM E ESTADO
// ════════════════════════════════════════════════════════════════════════════

interface LrcAnalysis {
  totalLines: number;
  syncedLines: number;
  isSynced: boolean;
  firstTs: string | null;
  lastTs: string | null;
  preview: string[];
  full: string[];
}

interface FlacInfo {
  file: File;
  name: string;
  stem: string;
  size: number;
  metadata: Map<string, string>;
  valid: boolean;
  error?: string;
  coverUrl?: string;
}

interface LrcInfo {
  file: File | null;
  name: string;
  stem: string;
  size: number;
  text: string;
  encoding: string;
  converted: boolean;
  analysis: LrcAnalysis;
  source: 'local' | 'lrclib' | 'extracted';
}

interface ProcessedResult {
  name: string;
  blob: Blob;
  url: string;
}

interface Pair {
  id: number;
  stem: string;
  flac: FlacInfo;
  lrc: LrcInfo | null;
  status: 'waiting' | 'processing' | 'done' | 'error';
  metadata: Map<string, string>;
  editedMeta: Map<string, string>;
  result: ProcessedResult | null;
  error: string | null;
  lrclibResults?: any[];
  selectedResultIdx?: number;
}

interface LogEntry {
  time: string;
  icon?: string;
  type?: 'info' | 'warn' | 'err' | 'ok';
  msg: string;
}

interface AppState {
  mode: 'embed' | 'extract' | 'verify';
  flacs: Map<string, FlacInfo>;
  lrcs: Map<string, LrcInfo>;
  pairs: Pair[];
  orphanFlacs: FlacInfo[];
  orphanLrcs: LrcInfo[];
  processed: ProcessedResult[];
  logs: LogEntry[];
  processing: boolean;
  currentLang: LangCode;
  currentPalette: 'clay' | 'sand' | 'stone' | 'onyx' | 'neon' | 'earth' | 'y2004' | 'y2005' | 'y2007' | 'y2008' | 'y2010' | 'y2011' | 'y2013' | 'y2016' | 'y2018a' | 'y2018b' | 'y2019' | 'y2021' | 'y2024a' | 'y2024b';
}

const state: AppState = {
  mode: 'embed',
  flacs: new Map(),
  lrcs: new Map(),
  pairs: [],
  orphanFlacs: [],
  orphanLrcs: [],
  processed: [],
  logs: [],
  processing: false,
  currentLang: 'pt-BR',
  currentPalette: 'clay',
};

let pairIdCounter = 0;

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 2: AUXILIARES E SELETORES DOM
// ════════════════════════════════════════════════════════════════════════════

const getEl = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado no DOM`);
  return el as T;
};

function getStem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.substring(0, dot) : name;
}

function fmtSize(b: number): string {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fmtTime(): string {
  const d = new Date();
  return d.toLocaleTimeString(state.currentLang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function saveLogsToStorage() {
  localStorage.setItem('lyrics_embedder_logs', JSON.stringify(state.logs));
}

function loadLogsFromStorage() {
  const saved = localStorage.getItem('lyrics_embedder_logs');
  if (saved) {
    try {
      state.logs = JSON.parse(saved);
    } catch {
      state.logs = [];
    }
  }
}

function addLog(type: 'info' | 'warn' | 'err' | 'ok', msg: string) {
  state.logs.push({ time: fmtTime(), type, msg, icon: '' });
  saveLogsToStorage();
  renderLog();
}

function esc(s: string): string {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 3: PARSE DE ENCODING E ANALISADOR LRC
// ════════════════════════════════════════════════════════════════════════════

function decodeFileContent(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  // BOM UTF-8 check
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)', converted: false };
  }
  // Try UTF-8 strict
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    return { text: dec.decode(bytes), encoding: 'UTF-8', converted: false };
  } catch {
    // ignore
  }
  // Fallback to Windows-1252
  try {
    const dec = new TextDecoder('windows-1252');
    return { text: dec.decode(bytes), encoding: 'Windows-1252', converted: true };
  } catch {
    // ignore
  }
  // Last resort: Latin-1
  const dec = new TextDecoder('iso-8859-1');
  return { text: dec.decode(bytes), encoding: 'ISO-8859-1', converted: true };
}

function analyzeLrc(text: string): LrcAnalysis {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const synced = lines.filter(l => /^\[\d{2}:\d{2}/.test(l));
  const isSynced = synced.length > lines.length * 0.3;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  for (const l of synced) {
    const m = l.match(/^\[(\d{2}:\d{2}[.\d]*)\]/);
    if (m) {
      if (!firstTs) firstTs = m[1];
      lastTs = m[1];
    }
  }
  return {
    totalLines: lines.length,
    syncedLines: synced.length,
    isSynced,
    firstTs,
    lastTs,
    preview: lines.slice(0, 10),
    full: lines,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 4: REGISTRO DE ARQUIVOS E PAREAMENTO
// ════════════════════════════════════════════════════════════════════════════

async function registerFiles(files: FileList | File[]) {
  const flacArr: File[] = [];
  const lrcArr: File[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const ext = f.name.split('.').pop()?.toLowerCase();
    if (ext === 'flac') flacArr.push(f);
    else if (ext === 'lrc') lrcArr.push(f);
  }

  // Ler metadados dos FLACs
  for (const f of flacArr) {
    const stem = getStem(f.name);
    if (state.flacs.has(stem)) continue; // Evitar duplicatas
    try {
      const chunkSize = Math.min(f.size, 12 * 1024 * 1024); // Aumentado para 12MB para comportar capas grandes
      const buf = await f.slice(0, chunkSize).arrayBuffer();
      const metadata = readFlacMetadata(buf);
      
      let coverUrl: string | undefined = undefined;
      try {
        const flacInfo = parseFlac(buf);
        const picBlock = flacInfo.metadataBlocks.find(b => b.type === MetadataBlockType.PICTURE);
        if (picBlock) {
          const coverData = extractCoverUrl(picBlock.data);
          if (coverData) {
            coverUrl = coverData.url;
          }
        }
      } catch (coverErr) {
        console.warn("Não foi possível extrair a imagem de capa:", coverErr);
      }

      state.flacs.set(stem, { file: f, name: f.name, stem, size: f.size, metadata, valid: true, coverUrl });
      addLog('info', getTranslation(state.currentLang, 'logFlacDetected', f.name));
    } catch (e: any) {
      state.flacs.set(stem, { file: f, name: f.name, stem, size: f.size, metadata: new Map(), valid: false, error: e.message });
      addLog('warn', getTranslation(state.currentLang, 'logFlacInvalid', f.name, e.message));
    }
  }

  // Ler conteúdo dos LRCs
  for (const f of lrcArr) {
    const stem = getStem(f.name);
    if (state.lrcs.has(stem)) continue;
    try {
      const buf = await f.arrayBuffer();
      const { text, encoding, converted } = decodeFileContent(buf);
      const analysis = analyzeLrc(text);
      state.lrcs.set(stem, { file: f, name: f.name, stem, size: f.size, text, encoding, converted, analysis, source: 'local' });
      if (converted) {
        addLog('info', getTranslation(state.currentLang, 'logLrcDetectedConverted', f.name, encoding));
      } else {
        addLog('info', getTranslation(state.currentLang, 'logLrcDetected', f.name));
      }
    } catch (e: any) {
      addLog('err', getTranslation(state.currentLang, 'logLrcDecodeError', f.name, e.message));
    }
  }

  if (state.mode === 'extract') {
    await prepareExtractMode();
  } else if (state.mode === 'verify') {
    await prepareVerifyMode();
  } else {
    createPairs();
  }
  renderAll();
}

function createPairs() {
  state.pairs = [];
  state.orphanFlacs = [];
  state.orphanLrcs = [];

  for (const [stem, flac] of state.flacs) {
    const lrc = state.lrcs.get(stem);
    const meta = new Map(flac.metadata);
    state.pairs.push({
      id: ++pairIdCounter,
      stem,
      flac,
      lrc: lrc || null,
      status: 'waiting',
      metadata: meta,
      editedMeta: new Map(meta),
      result: null,
      error: null,
    });
    if (!lrc) state.orphanFlacs.push(flac);
  }

  for (const [stem, lrc] of state.lrcs) {
    if (!state.flacs.has(stem)) state.orphanLrcs.push(lrc);
  }

  const paired = state.pairs.filter(p => p.lrc).length;
  if (paired > 0) addLog('ok', getTranslation(state.currentLang, 'logPairsDetected', paired));
  if (state.orphanFlacs.length > 0) addLog('warn', getTranslation(state.currentLang, 'logOrphanFlac', state.orphanFlacs.length));
  if (state.orphanLrcs.length > 0) addLog('warn', getTranslation(state.currentLang, 'logOrphanLrc', state.orphanLrcs.length));
}

async function prepareExtractMode() {
  state.pairs = [];
  state.orphanFlacs = [];
  state.orphanLrcs = [];
  for (const [stem, flac] of state.flacs) {
    try {
      const buf = await flac.file.slice(0, Math.min(flac.file.size, 1048576)).arrayBuffer();
      const result = extractLyricsFromBuffer(buf);
      const lrc: LrcInfo | null = result ? {
        file: null,
        name: `Tag: ${result.tag}`,
        stem,
        size: result.lyrics.length,
        text: result.lyrics,
        encoding: 'UTF-8',
        converted: false,
        analysis: analyzeLrc(result.lyrics),
        source: 'extracted'
      } : null;
      state.pairs.push({
        id: ++pairIdCounter,
        stem,
        flac,
        lrc,
        status: 'waiting',
        metadata: new Map(flac.metadata),
        editedMeta: new Map(flac.metadata),
        result: null,
        error: null,
      });
    } catch {
      state.pairs.push({
        id: ++pairIdCounter,
        stem,
        flac,
        lrc: null,
        status: 'waiting',
        metadata: new Map(flac.metadata),
        editedMeta: new Map(flac.metadata),
        result: null,
        error: null,
      });
    }
  }
}

async function prepareVerifyMode() {
  createPairs();
  for (const pair of state.pairs) {
    if (!pair.lrc) {
      fetchVerifyLyrics(pair);
    }
  }
}

async function fetchVerifyLyrics(pair: Pair, manualArtist?: string, manualTitle?: string) {
  const artist = manualArtist !== undefined ? manualArtist : (pair.editedMeta.get('ARTIST') || pair.metadata.get('ARTIST') || '');
  const title = manualTitle !== undefined ? manualTitle : (pair.editedMeta.get('TITLE') || pair.metadata.get('TITLE') || '');
  const album = pair.editedMeta.get('ALBUM') || pair.metadata.get('ALBUM') || '';

  if (manualArtist !== undefined) pair.editedMeta.set('ARTIST', manualArtist);
  if (manualTitle !== undefined) pair.editedMeta.set('TITLE', manualTitle);

  pair.status = 'processing';
  renderVerifyList();

  addLog('info', getTranslation(state.currentLang, 'logLrcSearchStart', title, artist));
  try {
    const results = await fetchLrclibAllResults(artist, title, album);
    if (!results || results.length === 0) {
      pair.status = 'error';
      pair.error = getTranslation(state.currentLang, 'verifyStatusError', '');
      pair.lrc = null;
      pair.lrclibResults = [];
      pair.selectedResultIdx = -1;
      addLog('err', getTranslation(state.currentLang, 'logLrcSearchNotFound', title));
    } else {
      const sortedResults = sortLrcResults(results);
      pair.lrclibResults = sortedResults;
      pair.selectedResultIdx = 0;

      const selected = sortedResults[0];
      const lyricsText = selected.syncedLyrics || selected.plainLyrics;
      const analysis = analyzeLrc(lyricsText);
      pair.lrc = {
        file: null,
        name: `${pair.stem}.lrc (LRCLIB)`,
        stem: pair.stem,
        size: lyricsText.length,
        text: lyricsText,
        encoding: 'UTF-8',
        converted: false,
        analysis,
        source: 'lrclib',
      };
      pair.status = 'waiting';
      pair.error = null;
      const syncLabel = getTranslation(state.currentLang, selected.syncedLyrics ? 'verifyBadgeSynced' : 'verifyBadgePlain');
      addLog('ok', getTranslation(state.currentLang, 'logLrcSearchFound', title, sortedResults.length, syncLabel));
    }
  } catch (err: any) {
    pair.status = 'error';
    pair.error = err.message;
    pair.lrc = null;
    pair.lrclibResults = [];
    pair.selectedResultIdx = -1;
    addLog('err', getTranslation(state.currentLang, 'logLrcSearchError', err.message));
  }
  renderVerifyList();
}

function renderVerifyList() {
  const container = getEl('verifyList');
  if (state.pairs.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  // 1. Salvar estado de foco e seleção do cursor
  let activePairId: number | null = null;
  let activeFieldClass: string | null = null;
  let cursorStart: number | null = null;
  let cursorEnd: number | null = null;

  const activeEl = document.activeElement as HTMLInputElement;
  if (activeEl && (activeEl.classList.contains('artist-inp') || activeEl.classList.contains('title-inp'))) {
    const card = activeEl.closest('.verify-card') as HTMLElement;
    if (card) {
      const pairIdStr = card.dataset.pairId;
      if (pairIdStr) {
        activePairId = parseInt(pairIdStr, 10);
        activeFieldClass = activeEl.classList.contains('artist-inp') ? 'artist-inp' : 'title-inp';
        cursorStart = activeEl.selectionStart;
        cursorEnd = activeEl.selectionEnd;
      }
    }
  }

  container.innerHTML = '';

  state.pairs.forEach((pair) => {
    const card = createVerifyCard(pair);
    card.dataset.pairId = String(pair.id);
    container.appendChild(card);
  });

  // 2. Restaurar foco e cursor
  if (activePairId !== null && activeFieldClass !== null) {
    const targetCard = container.querySelector(`.verify-card[data-pair-id="${activePairId}"]`) as HTMLElement;
    if (targetCard) {
      const targetInput = targetCard.querySelector(`.${activeFieldClass}`) as HTMLInputElement;
      if (targetInput) {
        targetInput.focus();
        if (cursorStart !== null && cursorEnd !== null) {
          targetInput.setSelectionRange(cursorStart, cursorEnd);
        }
      }
    }
  }
}

function getResultOptionLabel(res: any, index: number): string {
  const typeLabel = getTranslation(state.currentLang, res.syncedLyrics ? 'verifyBadgeSynced' : 'verifyBadgePlain');
  const durationLabel = res.duration ? ` [${formatDuration(res.duration)}]` : '';
  const albumLabel = res.albumName ? ` (${res.albumName})` : '';
  const trackName = res.trackName || getTranslation(state.currentLang, 'unknownTitle');
  const artistName = res.artistName || getTranslation(state.currentLang, 'unknownArtist');
  return `${index + 1}. [${typeLabel}] ${trackName} - ${artistName}${albumLabel}${durationLabel}`;
}

function createVerifyCard(pair: Pair): HTMLElement {
  const card = document.createElement('div');
  card.className = 'verify-card fade-in';

  const artist = pair.editedMeta.get('ARTIST') !== undefined ? pair.editedMeta.get('ARTIST')! : (pair.metadata.get('ARTIST') || '');
  const title = pair.editedMeta.get('TITLE') !== undefined ? pair.editedMeta.get('TITLE')! : (pair.metadata.get('TITLE') || pair.stem);

  let statusHtml = '';
  if (pair.status === 'processing') {
    statusHtml = `<div class="verify-status-msg loading">${esc(getTranslation(state.currentLang, 'verifyStatusLoading'))}</div>`;
  } else if (pair.status === 'error') {
    statusHtml = `<div class="verify-status-msg not-found">${esc(getTranslation(state.currentLang, 'verifyStatusError', pair.error || ''))}</div>`;
  } else if (pair.lrc) {
    const syncedMsg = pair.lrc.analysis.isSynced
      ? getTranslation(state.currentLang, 'verifyStatusFound', pair.lrc.analysis.syncedLines)
      : getTranslation(state.currentLang, 'verifyStatusFoundPlain');
    statusHtml = `<div class="verify-status-msg found">${esc(syncedMsg)}</div>`;
  } else {
    statusHtml = `<div class="verify-status-msg">${esc(getTranslation(state.currentLang, 'verifyStatusWaiting'))}</div>`;
  }

  let selectorHtml = '';
  if (pair.lrclibResults && pair.lrclibResults.length > 0) {
    const optionsHtml = pair.lrclibResults.map((res, idx) => {
      const isSelected = idx === pair.selectedResultIdx;
      return `<option value="${idx}" ${isSelected ? 'selected' : ''}>${esc(getResultOptionLabel(res, idx))}</option>`;
    }).join('');

    selectorHtml = `
      <div class="verify-results-container" style="display:flex; flex-direction:column; gap:6px;">
        <label class="verify-results-label">${esc(getTranslation(state.currentLang, 'verifySelectLabel'))}</label>
        <select class="verify-results-select">${optionsHtml}</select>
      </div>
    `;
  }

  let previewHtml = '';
  if (pair.lrc) {
    const isSynced = pair.lrc.analysis.isSynced;
    const badgeText = getTranslation(state.currentLang, isSynced ? 'verifyBadgeSynced' : 'verifyBadgePlain');
    const badgeClass = isSynced ? 'badge-synced' : 'badge-plain';

    let linesHtml = '';
    for (const line of pair.lrc.analysis.preview) {
      const m = line.match(/^(\[\d{2}:\d{2}[.\d]*\])\s*(.*)/);
      if (m) {
        linesHtml += `<div class="lrc-line"><span class="lrc-ts">${esc(m[1])}</span>${esc(m[2])}</div>`;
      } else {
        linesHtml += `<div class="lrc-line">${esc(line)}</div>`;
      }
    }
    if (pair.lrc.analysis.totalLines > 10) {
      linesHtml += `<div class="lrc-line" style="color:var(--tm);font-style:italic">${esc(getTranslation(state.currentLang, 'previewMoreLines', pair.lrc.analysis.totalLines - 10))}</div>`;
    }
    previewHtml = `
      <div class="verify-lyrics-container-box" style="position:relative; margin-top:8px;">
        <div class="preview-header-overlay" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span class="lrc-type-badge ${badgeClass}">${esc(badgeText)}</span>
          <button class="btn btn-sm btn-ghost btn-copy-lyrics" style="padding: 4px 12px; font-size: 0.7rem; border-radius: var(--r-sm); box-shadow: var(--nm-out-sm);">${esc(getTranslation(state.currentLang, 'verifyBtnCopy'))}</button>
        </div>
        <div class="verify-lyrics-preview">${linesHtml}</div>
      </div>
    `;
  }

  let actionsHtml = '';
  if (pair.lrc && pair.status !== 'processing') {
    actionsHtml = `
      <div class="verify-actions">
        <button class="btn btn-success btn-download-lrc">${esc(getTranslation(state.currentLang, 'verifyBtnDownload'))}</button>
        <button class="btn btn-primary btn-embed-audio">${esc(getTranslation(state.currentLang, 'verifyBtnEmbed'))}</button>
      </div>
    `;
  }

  const iconHtml = pair.flac.coverUrl 
    ? `<img src="${pair.flac.coverUrl}" class="album-cover-thumb verify-cover" alt="Capa" />` 
    : `<div class="pair-icon">♫</div>`;

  card.innerHTML = `
    <div class="verify-header-block" style="display:flex; gap:12px; align-items:center;">
      ${iconHtml}
      <div class="verify-title" style="flex:1;">${esc(pair.flac.name)}</div>
    </div>
    <div class="verify-meta-fields">
      <input type="text" class="verify-input artist-inp" placeholder="${esc(getTranslation(state.currentLang, 'placeholderArtist'))}" value="${esc(artist)}" />
      <input type="text" class="verify-input title-inp" placeholder="${esc(getTranslation(state.currentLang, 'placeholderTitle'))}" value="${esc(title)}" />
      <button class="btn btn-primary btn-search-manual">${esc(getTranslation(state.currentLang, 'verifyBtnSearch'))}</button>
    </div>
    ${selectorHtml}
    ${statusHtml}
    ${previewHtml}
    ${actionsHtml}
  `;

  // Bind actions
  setTimeout(() => {
    const artistInp = card.querySelector('.artist-inp') as HTMLInputElement;
    const titleInp = card.querySelector('.title-inp') as HTMLInputElement;

    let debounceTimer: any = null;
    const handleInputDebounce = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const currentArtist = pair.editedMeta.get('ARTIST') || '';
        const currentTitle = pair.editedMeta.get('TITLE') || '';
        if (artistInp.value.trim() === currentArtist.trim() && titleInp.value.trim() === currentTitle.trim()) {
          return; // Não alterou
        }
        if (pair.status === 'processing') return;
        fetchVerifyLyrics(pair, artistInp.value, titleInp.value);
      }, 600);
    };

    artistInp?.addEventListener('input', handleInputDebounce);
    titleInp?.addEventListener('input', handleInputDebounce);

    card.querySelector('.btn-search-manual')?.addEventListener('click', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      fetchVerifyLyrics(pair, artistInp.value, titleInp.value);
    });

    card.querySelector('.verify-results-select')?.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement;
      const idx = parseInt(select.value, 10);
      pair.selectedResultIdx = idx;

      const selected = pair.lrclibResults![idx];
      const lyricsText = selected.syncedLyrics || selected.plainLyrics;
      const analysis = analyzeLrc(lyricsText);
      pair.lrc = {
        file: null,
        name: `${pair.stem}.lrc (LRCLIB)`,
        stem: pair.stem,
        size: lyricsText.length,
        text: lyricsText,
        encoding: 'UTF-8',
        converted: false,
        analysis,
        source: 'lrclib',
      };

      const syncLabel = getTranslation(state.currentLang, selected.syncedLyrics ? 'verifyBadgeSynced' : 'verifyBadgePlain');
      addLog('info', getTranslation(state.currentLang, 'logLrcVersionChanged', selected.trackName, syncLabel));
      renderVerifyList();
    });

    card.querySelector('.btn-copy-lyrics')?.addEventListener('click', (e) => {
      if (!pair.lrc) return;
      const btn = e.target as HTMLButtonElement;
      navigator.clipboard.writeText(pair.lrc.text).then(() => {
        const originalText = btn.textContent;
        btn.textContent = getTranslation(state.currentLang, 'verifyBtnCopyDone');
        btn.style.color = 'var(--ok)';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.color = '';
        }, 1500);
      }).catch(err => {
        console.error("Falha ao copiar letras:", err);
      });
    });

    card.querySelector('.btn-download-lrc')?.addEventListener('click', () => {
      if (!pair.lrc) return;
      const blob = new Blob([pair.lrc.text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = pair.stem + '.lrc';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addLog('ok', getTranslation(state.currentLang, 'logLrcDownload', pair.stem));
    });

    card.querySelector('.btn-embed-audio')?.addEventListener('click', async (e) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = getTranslation(state.currentLang, 'statusProcessing');

      try {
        const embedCheckbox = document.getElementById('optEmbedLrc') as HTMLInputElement;
        const oldVal = embedCheckbox ? embedCheckbox.checked : true;
        if (embedCheckbox) embedCheckbox.checked = true;

        await processSinglePair(pair);

        if (embedCheckbox) embedCheckbox.checked = oldVal;

        if (pair.result) {
          const a = document.createElement('a');
          a.href = pair.result.url;
          a.download = pair.result.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          addLog('ok', getTranslation(state.currentLang, 'logEmbedAudioSuccess', pair.result.name));
        }
      } catch (err: any) {
        addLog('err', getTranslation(state.currentLang, 'logEmbedAudioError', err.message));
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  }, 0);

  return card;
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 5: INTEGRACAO LRCLIB
// ════════════════════════════════════════════════════════════════════════════

async function fetchLrclib(artist: string, title: string, album: string) {
  const params = new URLSearchParams();
  if (title) params.set('track_name', title);
  if (artist) params.set('artist_name', artist);
  if (album) params.set('album_name', album);
  const url = `https://lrclib.net/api/search?${params}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'FLACLyricsEmbedder/2.0 (browser-client)' }
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (Array.isArray(data)) {
    return data.find(r => r.syncedLyrics) || data.find(r => r.plainLyrics) || null;
  }
  return data;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function sortLrcResults(results: any[]): any[] {
  return [...results].sort((a, b) => {
    const aHasSynced = !!a.syncedLyrics;
    const bHasSynced = !!b.syncedLyrics;
    if (aHasSynced && !bHasSynced) return -1;
    if (!aHasSynced && bHasSynced) return 1;
    return 0;
  });
}

async function fetchLrclibAllResults(artist: string, title: string, album: string): Promise<any[]> {
  const params = new URLSearchParams();
  if (title) params.set('track_name', title);
  if (artist) params.set('artist_name', artist);
  if (album) params.set('album_name', album);
  const url = `https://lrclib.net/api/search?${params}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'FLACLyricsEmbedder/2.0 (browser-client)' }
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  if (Array.isArray(data)) {
    return data.filter(r => r.syncedLyrics || r.plainLyrics);
  }
  if (data && (data.syncedLyrics || data.plainLyrics)) {
    return [data];
  }
  return [];
}

async function tryFetchForPair(pair: Pair): Promise<boolean> {
  const artist = pair.metadata.get('ARTIST') || '';
  const title = pair.metadata.get('TITLE') || '';
  const album = pair.metadata.get('ALBUM') || '';
  if (!artist && !title) {
    addLog('warn', getTranslation(state.currentLang, 'logNoMetaSearch', pair.flac.name));
    return false;
  }
  addLog('info', getTranslation(state.currentLang, 'logLrcSearchStart', title, artist));
  try {
    const result = await fetchLrclib(artist, title, album);
    if (!result || (!result.syncedLyrics && !result.plainLyrics)) {
      addLog('err', getTranslation(state.currentLang, 'logLrcSearchNotFound', title));
      return false;
    }
    const lyricsText = result.syncedLyrics || result.plainLyrics;
    const analysis = analyzeLrc(lyricsText);
    const lrcInfo: LrcInfo = {
      file: null,
      name: `${pair.stem}.lrc (LRCLIB)`,
      stem: pair.stem,
      size: lyricsText.length,
      text: lyricsText,
      encoding: 'UTF-8',
      converted: false,
      analysis,
      source: 'lrclib',
    };
    state.lrcs.set(pair.stem, lrcInfo);
    pair.lrc = lrcInfo;
    addLog('ok', getTranslation(state.currentLang, 'logLrcSearchFoundBatch', title, analysis.syncedLines));
    renderAll();
    return true;
  } catch (e: any) {
    addLog('err', getTranslation(state.currentLang, 'logLrcSearchError', e.message));
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 6: PROCESSAMENTO - EMBUTIR E EXTRAIR
// ════════════════════════════════════════════════════════════════════════════

async function processAll() {
  const optConvertOpus = (document.getElementById('optConvertOpus') as HTMLInputElement)?.checked;
  if (optConvertOpus) {
    runLocalConversionBatch();
    return;
  }

  const toProcess = state.pairs.filter(p => p.status !== 'done');
  if (toProcess.length === 0) return;

  state.processing = true;
  showProgress(true);
  // Limpar resultados anteriores
  for (const p of state.processed) {
    if (p.url) URL.revokeObjectURL(p.url);
  }
  state.processed = [];

  const optFetchLrc = (document.getElementById('optFetchLrc') as HTMLInputElement)?.checked;

  let done = 0;
  let errors = 0;
  for (const pair of toProcess) {
    pair.status = 'processing';
    renderPairStatus(pair);

    // Auto-busca online da letra se ativado e não houver letra local
    if (optFetchLrc && !pair.lrc) {
      await tryFetchForPair(pair);
    }

    try {
      await processSinglePair(pair);
      pair.status = 'done';
      done++;
    } catch (e: any) {
      pair.status = 'error';
      pair.error = e.message;
      errors++;
      addLog('err', getTranslation(state.currentLang, 'logExtractError', pair.flac.name, e.message));
    }
    renderPairStatus(pair);
    const total = toProcess.length;
    const current = done + errors;
    updateProgress((current / total) * 100, `${current} / ${total}...`);
    await new Promise(r => setTimeout(r, 40)); // Animação
  }

  state.processing = false;
  const errPart = errors > 0 ? getTranslation(state.currentLang, 'resultsDescErrorPart', errors) : '';
  addLog('ok', getTranslation(state.currentLang, 'logBatchSuccess', done, toProcess.length, errPart));
  showProgress(false);
  renderResults();
}

async function processSinglePair(pair: Pair) {
  addLog('info', getTranslation(state.currentLang, 'logEmbedAudioStart', pair.flac.name));
  const buffer = await pair.flac.file.arrayBuffer();

  const updates = new Map<string, string | null>();
  for (const [k, v] of pair.editedMeta) {
    const original = pair.metadata.get(k);
    if (v !== original && v.trim()) updates.set(k, v);
  }
  for (const [k, v] of pair.editedMeta) {
    if (!v.trim() && pair.metadata.has(k)) updates.set(k, null);
  }

  // Verifica opção de embutir letras
  const optEmbedLrc = (document.getElementById('optEmbedLrc') as HTMLInputElement)?.checked;
  if (optEmbedLrc && pair.lrc) {
    updates.set('LYRICS', pair.lrc.text);
  }

  const result = updateFlacMetadata(buffer, updates);

  // Se houver uma letra e optEmbedLrc estiver desmarcado, gera um arquivo .lrc separado
  if (pair.lrc && !optEmbedLrc) {
    const lrcBlob = new Blob([pair.lrc.text], { type: 'text/plain;charset=utf-8' });
    const lrcUrl = URL.createObjectURL(lrcBlob);
    const lrcName = pair.stem + '.lrc';
    state.processed.push({ name: lrcName, blob: lrcBlob, url: lrcUrl });
    addLog('info', getTranslation(state.currentLang, 'logLrcStandaloneGenerated', lrcName));
  }

  const optConvertOpus = (document.getElementById('optConvertOpus') as HTMLInputElement)?.checked;
  if (optConvertOpus) {
    if (!isOpusEncodingSupported()) {
      addLog('warn', getTranslation(state.currentLang, 'logOpusNotSupported', pair.flac.name));
      const blob = new Blob([result], { type: 'audio/flac' });
      const url = URL.createObjectURL(blob);
      pair.result = { name: pair.flac.name, blob, url };
      state.processed.push(pair.result);
      addLog('info', getTranslation(state.currentLang, 'logFlacEmbeddedFallback', pair.flac.name));
    } else {
      addLog('info', getTranslation(state.currentLang, 'logOpusConverting', pair.flac.name));
      try {
        const finalMetadata = new Map<string, string>();
        for (const [k, v] of pair.metadata) {
          finalMetadata.set(k, v);
        }
        for (const [k, v] of updates) {
          if (v === null) {
            finalMetadata.delete(k);
          } else {
            finalMetadata.set(k, v);
          }
        }

        const opusData = await encodeFlacToOpus(result, finalMetadata, (pct) => {
          const progressTextEl = document.getElementById('progressText');
          if (progressTextEl) {
            progressTextEl.textContent = `${getTranslation(state.currentLang, 'logOpusConverting', pair.stem)}: ${pct}%`;
          }
        });
        const opusBlob = new Blob([opusData as any], { type: 'audio/ogg;codecs=opus' });
        const opusUrl = URL.createObjectURL(opusBlob);
        const opusName = pair.stem + '.opus';
        pair.result = { name: opusName, blob: opusBlob, url: opusUrl };
        state.processed.push(pair.result);
        addLog('ok', getTranslation(state.currentLang, 'logOpusSuccess', opusName));
      } catch (err: any) {
        pair.status = 'error';
        pair.error = err.message;
        addLog('err', getTranslation(state.currentLang, 'logOpusError', pair.flac.name, err.message));
        throw err;
      }
    }
  } else {
    const blob = new Blob([result], { type: 'audio/flac' });
    const url = URL.createObjectURL(blob);
    pair.result = { name: pair.flac.name, blob, url };
    state.processed.push(pair.result);
    addLog('info', getTranslation(state.currentLang, 'logFlacSuccess', pair.flac.name));
  }
}

async function extractAll() {
  state.processing = true;
  showProgress(true);
  for (const p of state.processed) {
    if (p.url) URL.revokeObjectURL(p.url);
  }
  state.processed = [];

  let done = 0;
  let errors = 0;
  const total = state.pairs.length;

  for (const pair of state.pairs) {
    pair.status = 'processing';
    renderPairStatus(pair);
    try {
      addLog('info', getTranslation(state.currentLang, 'logExtractStart', pair.flac.name));
      const buf = await pair.flac.file.arrayBuffer();
      const result = extractLyricsFromBuffer(buf);
      if (result) {
        const lrcName = pair.stem + '.lrc';
        const blob = new Blob([result.lyrics], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        pair.result = { name: lrcName, blob, url };
        pair.lrc = {
          file: null,
          text: result.lyrics,
          analysis: analyzeLrc(result.lyrics),
          source: 'extracted',
          name: `Tag: ${result.tag}`,
          stem: pair.stem,
          size: result.lyrics.length,
          encoding: 'UTF-8',
          converted: false,
        };
        state.processed.push(pair.result);
        pair.status = 'done';
        done++;
        addLog('ok', getTranslation(state.currentLang, 'logExtractSuccess', pair.flac.name, result.tag));
      } else {
        pair.status = 'error';
        pair.error = getTranslation(state.currentLang, 'extractNoLyrics');
        errors++;
        addLog('warn', getTranslation(state.currentLang, 'logExtractNotFound', pair.flac.name));
      }
    } catch (e: any) {
      pair.status = 'error';
      pair.error = e.message;
      errors++;
      addLog('err', getTranslation(state.currentLang, 'logExtractError', pair.flac.name, e.message));
    }
    renderPairStatus(pair);
    updateProgress(((done + errors) / total) * 100, `${done + errors} / ${total}...`);
    await new Promise(r => setTimeout(r, 40));
  }

  state.processing = false;
  const errPart = errors > 0 ? getTranslation(state.currentLang, 'resultsDescErrorPart', errors) : '';
  addLog('ok', getTranslation(state.currentLang, 'logBatchExtractSuccess', done, total, errPart));
  showProgress(false);
  renderResults();
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 7: COMPARADOR METADADOS (DIFF)
// ════════════════════════════════════════════════════════════════════════════

interface DiffRow {
  key: string;
  type: 'added' | 'removed' | 'modified' | 'unchanged';
  oldVal?: string;
  newVal?: string;
  val?: string;
}

function computeDiff(pair: Pair): DiffRow[] {
  const old = pair.metadata;
  const edited = pair.editedMeta;
  const diff: DiffRow[] = [];
  const allKeys = new Set([...old.keys(), ...edited.keys()]);
  if (pair.lrc) allKeys.add('LYRICS');

  for (const key of allKeys) {
    const oldVal = old.get(key);
    let newVal = edited.get(key);
    if (key === 'LYRICS') {
      newVal = pair.lrc ? '(' + getTranslation(state.currentLang, 'statLrc') + ' — ' + getTranslation(state.currentLang, 'previewLines', pair.lrc.analysis?.totalLines || '?') + ')' : oldVal;
    }

    if (!oldVal && newVal) {
      diff.push({ key, type: 'added', newVal });
    } else if (oldVal && !newVal) {
      diff.push({ key, type: 'removed', oldVal });
    } else if (oldVal !== newVal) {
      diff.push({ key, type: 'modified', oldVal, newVal });
    } else {
      diff.push({ key, type: 'unchanged', val: oldVal });
    }
  }

  return diff.sort((a, b) => {
    const order = { added: 0, modified: 1, removed: 2, unchanged: 3 };
    return order[a.type] - order[b.type];
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 8: DOWNLOAD E ZIP
// ════════════════════════════════════════════════════════════════════════════

function downloadSingle(item: ProcessedResult) {
  const a = document.createElement('a');
  a.href = item.url;
  a.download = item.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function downloadAllZip() {
  addLog('ok', getTranslation(state.currentLang, 'logZipStart'));
  const zip = new JSZip();
  for (const item of state.processed) {
    zip.file(item.name, item.blob);
  }
  showProgress(true);
  const content = await zip.generateAsync({ type: 'blob' }, (meta) => {
    updateProgress(meta.percent, getTranslation(state.currentLang, 'logZipStart'));
  });
  showProgress(false);
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'flac_lyrics_output.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  addLog('ok', getTranslation(state.currentLang, 'logZipSuccess'));
}

function downloadAllIndividual() {
  for (const item of state.processed) {
    downloadSingle(item);
  }
}

async function processAllVerify() {
  const optConvertOpus = (document.getElementById('optConvertOpus') as HTMLInputElement)?.checked;
  if (optConvertOpus) {
    runLocalConversionBatch();
    return;
  }

  const toProcess = state.pairs.filter(p => p.status !== 'done' && p.lrc);
  if (toProcess.length === 0) {
    addLog('warn', getTranslation(state.currentLang, 'logNoEmbedLrcFoundVerify'));
    return;
  }

  state.processing = true;
  showProgress(true);
  
  // Limpar resultados anteriores
  for (const p of state.processed) {
    if (p.url) URL.revokeObjectURL(p.url);
  }
  state.processed = [];

  let done = 0;
  let errors = 0;
  for (const pair of toProcess) {
    pair.status = 'processing';
    renderVerifyList();

    try {
      const embedCheckbox = document.getElementById('optEmbedLrc') as HTMLInputElement;
      const oldVal = embedCheckbox ? embedCheckbox.checked : true;
      if (embedCheckbox) embedCheckbox.checked = true;

      await processSinglePair(pair);

      if (embedCheckbox) embedCheckbox.checked = oldVal;
      pair.status = 'done';
      done++;
    } catch (e: any) {
      pair.status = 'error';
      pair.error = e.message;
      errors++;
      addLog('err', getTranslation(state.currentLang, 'logEmbedAudioError', pair.flac.name + ': ' + e.message));
    }

    renderVerifyList();
    const total = toProcess.length;
    const current = done + errors;
    updateProgress((current / total) * 100, `${current} / ${total}...`);
    await new Promise(r => setTimeout(r, 40));
  }

  state.processing = false;
  const errPart = errors > 0 ? getTranslation(state.currentLang, 'resultsDescErrorPart', errors) : '';
  addLog('ok', getTranslation(state.currentLang, 'logBatchVerifyFinished', done, errPart));
  showProgress(false);
  renderResults();
}

async function downloadAllVerifyLrcZip() {
  const resolved = state.pairs.filter(p => p.lrc);
  if (resolved.length === 0) {
    addLog('warn', getTranslation(state.currentLang, 'logNoEmbedLrcFoundVerify'));
    return;
  }
  addLog('ok', getTranslation(state.currentLang, 'logZipStart'));
  const zip = new JSZip();
  for (const pair of resolved) {
    if (pair.lrc) {
      zip.file(pair.stem + '.lrc', pair.lrc.text);
    }
  }
  showProgress(true);
  const content = await zip.generateAsync({ type: 'blob' }, (meta) => {
    updateProgress(meta.percent, getTranslation(state.currentLang, 'logZipStart'));
  });
  showProgress(false);
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lyrics_output.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  addLog('ok', getTranslation(state.currentLang, 'logLrcZipVerify'));
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 9: RENDERIZAÇÃO DA INTERFACE (UI)
// ════════════════════════════════════════════════════════════════════════════

function renderAll() {
  const optConvertOpus = (document.getElementById('optConvertOpus') as HTMLInputElement)?.checked;
  if (optConvertOpus) {
    getEl('statsBar').classList.add('hidden');
    getEl('actions').classList.add('hidden');
    getEl('pairList').classList.add('hidden');
    getEl('verifyList').classList.add('hidden');
    getEl('dropzone').classList.add('hidden');
    renderLog();
    return;
  }

  renderStats();
  if (state.mode === 'verify') {
    getEl('pairList').classList.add('hidden');
    getEl('actions').classList.remove('hidden');
    getEl('verifyList').classList.remove('hidden');
    renderVerifyList();
    renderActions();
  } else {
    getEl('verifyList').classList.add('hidden');
    getEl('pairList').classList.remove('hidden');
    renderPairs();
    renderActions();
  }
  renderLog();
}

function renderStats() {
  const bar = getEl('statsBar');
  const total = state.flacs.size + state.lrcs.size;
  if (total === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  getEl('sFlac').textContent = String(state.flacs.size);
  getEl('sLrc').textContent = String(state.lrcs.size);
  const paired = state.pairs.filter(p => p.lrc).length;
  getEl('sPaired').textContent = String(paired);
  getEl('sOrphan').textContent = String(state.orphanFlacs.length + state.orphanLrcs.length);
}

function renderPairs() {
  const container = getEl('pairList');
  if (state.pairs.length === 0 && state.orphanLrcs.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = '';

  // Animação stagger no carregamento da lista
  state.pairs.forEach((pair, idx) => {
    const card = createPairCard(pair);
    card.style.animationDelay = `${idx * 0.08}s`;
    container.appendChild(card);
  });

  // LRCs órfãos
  state.orphanLrcs.forEach((lrc, idx) => {
    const card = document.createElement('div');
    card.className = 'pair-card fade-in';
    card.style.animationDelay = `${(state.pairs.length + idx) * 0.08}s`;
    card.innerHTML = `
      <div class="pair-header">
        <div class="pair-icon">▤</div>
        <div class="pair-info">
          <div class="pair-names">
            <span>${esc(lrc.name)}</span>
            <span class="no-lrc">${esc(getTranslation(state.currentLang, 'noFlacMatch'))}</span>
          </div>
          <div class="pair-meta"><span>${fmtSize(lrc.size)}</span></div>
        </div>
        <div class="pair-right"><span class="pair-status waiting">${esc(getTranslation(state.currentLang, 'statusNoPair'))}</span></div>
      </div>`;
    container.appendChild(card);
  });
}

function createPairCard(pair: Pair): HTMLElement {
  const card = document.createElement('div');
  card.className = 'pair-card fade-in';
  card.id = `pair-${pair.id}`;

  const isEmbed = state.mode === 'embed';
  const hasLrc = !!pair.lrc;
  const statusCls = pair.status;
  const statusLabels = {
    waiting: getTranslation(state.currentLang, 'statusWaiting'),
    processing: getTranslation(state.currentLang, 'statusProcessing'),
    done: getTranslation(state.currentLang, 'statusDone'),
    error: getTranslation(state.currentLang, 'statusError')
  };

  const iconHtml = pair.flac.coverUrl 
    ? `<img src="${pair.flac.coverUrl}" class="album-cover-thumb" alt="Capa" />` 
    : `<div class="pair-icon">♫</div>`;

  let namesHtml = `<span class="flac-name">${esc(pair.flac.name)}</span>`;
  if (hasLrc && pair.lrc) {
    const srcBadge = pair.lrc.source === 'lrclib' ? ' <span class="lrclib-badge">LRCLIB</span>' : '';
    namesHtml += `<span class="arrow">↔</span><span class="lrc-name">${esc(pair.lrc.name || pair.lrc.stem + '.lrc')}${srcBadge}</span>`;
  } else if (isEmbed) {
    namesHtml += `<span class="no-lrc">${esc(getTranslation(state.currentLang, 'noLrcMatch'))}</span>`;
  }

  let metaHtml = `<span>${fmtSize(pair.flac.size)}</span>`;
  const artist = pair.metadata.get('ARTIST');
  const title = pair.metadata.get('TITLE');
  if (artist || title) {
    metaHtml += `<span>${esc((artist || '?') + ' — ' + (title || '?'))}</span>`;
  }

  let rightHtml = `<span class="pair-status ${statusCls}">${statusLabels[pair.status] || pair.status}</span>`;
  rightHtml += `<button class="pair-expand" data-pair="${pair.id}" aria-label="Expandir detalhes">▼</button>`;

  card.innerHTML = `
    <div class="pair-header" data-pair="${pair.id}">
      ${iconHtml}
      <div class="pair-info">
        <div class="pair-names">${namesHtml}</div>
        <div class="pair-meta">${metaHtml}</div>
      </div>
      <div class="pair-right">${rightHtml}</div>
    </div>
    <div class="pair-details" id="details-${pair.id}">
      <div class="pair-details-inner">
        ${isEmbed ? renderEmbedDetails(pair) : renderExtractDetails(pair)}
      </div>
    </div>`;

  // Expand click handlers
  const toggleDetails = () => {
    const details = card.querySelector('.pair-details') as HTMLElement;
    const btn = card.querySelector('.pair-expand') as HTMLElement;
    if (details.classList.contains('open')) {
      details.classList.remove('open');
      btn.classList.remove('open');
    } else {
      details.classList.add('open');
      btn.classList.add('open');
    }
  };

  card.querySelector('.pair-expand')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDetails();
  });
  card.querySelector('.pair-header')?.addEventListener('click', () => {
    toggleDetails();
  });

  // Bind inputs dynamically
  setTimeout(() => {
    const inputs = card.querySelectorAll<HTMLInputElement>('.meta-input[data-key]');
    inputs.forEach(inp => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.key!;
        pair.editedMeta.set(key, inp.value);
        // Live diff update
        const diffEl = card.querySelector('.diff-view');
        if (diffEl) diffEl.innerHTML = renderDiffHtml(pair);
      });
    });

    // Copy lyrics click
    card.querySelector('.btn-copy-lyrics')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target as HTMLButtonElement;
      navigator.clipboard.writeText(pair.lrc?.text || '').then(() => {
        btn.textContent = getTranslation(state.currentLang, 'verifyBtnCopyDone');
        setTimeout(() => {
          btn.textContent = getTranslation(state.currentLang, 'verifyBtnCopy');
        }, 1500);
      });
    });

    // LRCLIB click
    card.querySelector('.btn-lrclib')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = getTranslation(state.currentLang, 'statusProcessing');
      await tryFetchForPair(pair);
      btn.disabled = false;
      btn.textContent = getTranslation(state.currentLang, 'verifyBtnSearch') + ' (LRCLIB)';
    });

    // Individual process click
    card.querySelector('.btn-process-one')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!pair.lrc) return;
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      pair.status = 'processing';
      renderPairStatus(pair);
      try {
        await processSinglePair(pair);
        pair.status = 'done';
        addLog('ok', getTranslation(state.currentLang, 'logEmbedAudioSuccess', pair.flac.name));
      } catch (err: any) {
        pair.status = 'error';
        pair.error = err.message;
        addLog('err', getTranslation(state.currentLang, 'logEmbedAudioError', err.message));
      }
      renderPairStatus(pair);
      renderActions();
      btn.disabled = false;
    });
  }, 0);

  return card;
}

function renderEmbedDetails(pair: Pair): string {
  let html = '';

  if (pair.lrc) {
    const a = pair.lrc.analysis;
    const badgeText = getTranslation(state.currentLang, a.isSynced ? 'verifyBadgeSynced' : 'verifyBadgePlain');
    const badgeClass = a.isSynced ? 'badge-synced' : 'badge-plain';

    let infoHtml = `<span>${getTranslation(state.currentLang, 'previewLines', a.totalLines)}</span>`;
    if (a.firstTs && a.lastTs) infoHtml += `<span>${a.firstTs} → ${a.lastTs}</span>`;

    let linesHtml = '';
    for (const line of a.preview) {
      const m = line.match(/^(\[\d{2}:\d{2}[.\d]*\])\s*(.*)/);
      if (m) linesHtml += `<div class="lrc-line"><span class="lrc-ts">${esc(m[1])}</span>${esc(m[2])}</div>`;
      else linesHtml += `<div class="lrc-line">${esc(line)}</div>`;
    }
    if (a.totalLines > 10) {
      linesHtml += `<div class="lrc-line" style="color:var(--tm);font-style:italic">${esc(getTranslation(state.currentLang, 'previewMoreLines', a.totalLines - 10))}</div>`;
    }

    let warnHtml = '';
    if (pair.lrc.converted) {
      warnHtml = `<div class="lrc-encoding-warn">${esc(getTranslation(state.currentLang, 'previewEncodingWarn', pair.lrc.encoding))}</div>`;
    }

    html += `
      <div class="section-title">${esc(getTranslation(state.currentLang, 'sectionPreview'))}</div>
      <div class="lrc-preview">
        <div class="verify-preview-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
          <span class="lrc-type-badge ${badgeClass}">${esc(badgeText)}</span>
          <button class="btn btn-sm btn-ghost btn-copy-lyrics" style="padding: 4px 12px; font-size: 0.7rem; border-radius: var(--r-sm); box-shadow: var(--nm-out-sm); margin-left:auto;">${esc(getTranslation(state.currentLang, 'verifyBtnCopy'))}</button>
        </div>
        <div class="lrc-info" style="border-top: 1px solid rgba(0,0,0,.06); padding-top: 6px; margin-top: 6px; border-bottom: none;">${infoHtml}</div>
        ${linesHtml}
      </div>
      ${warnHtml}`;
  } else {
    const artist = pair.metadata.get('ARTIST');
    const title = pair.metadata.get('TITLE');
    html += `<div class="lrclib-panel">
      <div class="lrclib-status">${esc(getTranslation(state.currentLang, 'embedNoLrcFound'))}</div>
      ${(artist || title) ? `<div class="lrclib-actions"><button class="btn btn-sm btn-primary btn-lrclib">${esc(getTranslation(state.currentLang, 'verifyBtnSearch'))} (LRCLIB)</button></div>` : `<div class="lrclib-status" style="margin-top:4px">${esc(getTranslation(state.currentLang, 'embedNoMeta'))}</div>`}
    </div>`;
  }

  // Editor de metadados
  const fields = [
    { key: 'TITLE', label: getTranslation(state.currentLang, 'placeholderTitle') },
    { key: 'ARTIST', label: getTranslation(state.currentLang, 'placeholderArtist') },
    { key: 'ALBUM', label: getTranslation(state.currentLang, 'metaAlbum') },
    { key: 'DATE', label: getTranslation(state.currentLang, 'metaYear'), half: true },
    { key: 'TRACKNUMBER', label: getTranslation(state.currentLang, 'metaTrack'), half: true },
  ];
  let fieldsHtml = '';
  for (const f of fields) {
    const val = pair.editedMeta.get(f.key) || '';
    fieldsHtml += `<div class="meta-field${f.half ? '' : ' full'}">
      <label class="meta-label">${esc(f.label)}</label>
      <input class="meta-input" data-key="${f.key}" value="${esc(val)}" placeholder="${esc(f.label)}..." />
    </div>`;
  }
  html += `<div class="section-title" style="margin-top:8px">${esc(getTranslation(state.currentLang, 'sectionMetadata'))}</div><div class="meta-editor">${fieldsHtml}</div>`;

  // Diff
  if (pair.lrc) {
    html += `<div class="section-title" style="margin-top:8px">${esc(getTranslation(state.currentLang, 'sectionChanges'))}</div><div class="diff-view">${renderDiffHtml(pair)}</div>`;
  }

  // Individual button
  if (pair.lrc && pair.status === 'waiting') {
    html += `<div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn btn-sm btn-primary btn-process-one">${esc(getTranslation(state.currentLang, 'btnProcessOne'))}</button></div>`;
  }

  return html;
}

function renderExtractDetails(pair: Pair): string {
  if (!pair.lrc) {
    return `<div class="lrclib-panel"><div class="lrclib-status">${esc(getTranslation(state.currentLang, 'extractNoLyrics'))}</div></div>`;
  }

  const a = pair.lrc.analysis;
  let infoHtml = `<span>${getTranslation(state.currentLang, 'previewLines', a.totalLines)}</span>`;
  if (a.isSynced) infoHtml += `<span>${getTranslation(state.currentLang, 'previewSynced', a.syncedLines)}</span>`;

  let linesHtml = '';
  for (const line of a.preview) {
    const m = line.match(/^(\[\d{2}:\d{2}[.\d]*\])\s*(.*)/);
    if (m) linesHtml += `<div class="lrc-line"><span class="lrc-ts">${esc(m[1])}</span>${esc(m[2])}</div>`;
    else linesHtml += `<div class="lrc-line">${esc(line)}</div>`;
  }
  if (a.totalLines > 10) {
    linesHtml += `<div class="lrc-line" style="color:var(--tm);font-style:italic">${esc(getTranslation(state.currentLang, 'previewMoreLines', a.totalLines - 10))}</div>`;
  }

  return `
    <div class="section-title">${esc(getTranslation(state.currentLang, 'extractTitle', pair.lrc.name))}</div>
    <div class="lrc-preview"><div class="lrc-info">${infoHtml}</div>${linesHtml}</div>`;
}

function renderDiffHtml(pair: Pair): string {
  const diff = computeDiff(pair);
  const META_KEYS = ['TITLE', 'ARTIST', 'ALBUM', 'DATE', 'TRACKNUMBER', 'LYRICS'];
  const filtered = diff.filter(d => META_KEYS.includes(d.key));

  return filtered.map(d => {
    let valHtml = '';
    if (d.type === 'added') {
      const display = d.key === 'LYRICS' ? d.newVal : esc(d.newVal || '');
      valHtml = `<span class="tag add">${esc(getTranslation(state.currentLang, 'diffTagNew'))}</span> ${display}`;
    } else if (d.type === 'modified') {
      const oldD = d.key === 'LYRICS' ? getTranslation(state.currentLang, 'diffPrevLyrics') : esc(d.oldVal || '');
      const newD = d.key === 'LYRICS' ? d.newVal : esc(d.newVal || '');
      valHtml = `<span class="old">${oldD}</span> → <span class="new">${newD}</span>`;
    } else if (d.type === 'removed') {
      valHtml = `<span class="tag del">${esc(getTranslation(state.currentLang, 'diffTagRemoved'))}</span> ${esc(d.oldVal || '')}`;
    } else {
      const display = d.key === 'LYRICS' ? getTranslation(state.currentLang, 'diffExistLyrics') : esc(d.val || '');
      valHtml = display;
    }
    return `<div class="diff-row ${d.type}"><span class="diff-key">${d.key}</span><span class="diff-val">${valHtml}</span></div>`;
  }).join('');
}

function renderPairStatus(pair: Pair) {
  const card = document.getElementById(`pair-${pair.id}`);
  if (!card) return;
  const statusEl = card.querySelector('.pair-status');
  if (statusEl) {
    const labels = {
      waiting: getTranslation(state.currentLang, 'statusWaiting'),
      processing: getTranslation(state.currentLang, 'statusProcessing'),
      done: getTranslation(state.currentLang, 'statusDone'),
      error: getTranslation(state.currentLang, 'statusError')
    };
    statusEl.className = `pair-status ${pair.status}`;
    statusEl.textContent = labels[pair.status] || pair.status;
    if (pair.status === 'error' && pair.error) {
      statusEl.setAttribute('title', pair.error);
    }
  }
}

function renderActions() {
  const container = getEl('actions');
  if (state.pairs.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = '';

  if (state.mode === 'embed') {
    const processable = state.pairs.filter(p => p.status !== 'done').length;
    const btn = mkBtn(getTranslation(state.currentLang, 'btnProcessAll'), 'btn-primary', processAll);
    btn.disabled = processable === 0 || state.processing;
    container.appendChild(btn);
  } else if (state.mode === 'extract') {
    const extractable = state.pairs.filter(p => p.status !== 'done').length;
    const btn = mkBtn(getTranslation(state.currentLang, 'btnExtractAll'), 'btn-primary', extractAll);
    btn.disabled = extractable === 0 || state.processing;
    container.appendChild(btn);
  } else if (state.mode === 'verify') {
    const processable = state.pairs.filter(p => p.status !== 'done' && p.lrc).length;
    const btnEmbed = mkBtn(getTranslation(state.currentLang, 'btnEmbedAllVerify'), 'btn-primary', processAllVerify);
    btnEmbed.disabled = processable === 0 || state.processing;
    container.appendChild(btnEmbed);

    const hasLrc = state.pairs.some(p => p.lrc);
    const btnZipLrc = mkBtn(getTranslation(state.currentLang, 'btnZipAllVerify'), 'btn-success', downloadAllVerifyLrcZip);
    btnZipLrc.disabled = !hasLrc || state.processing;
    container.appendChild(btnZipLrc);
  }

  const optConvertOpus = (document.getElementById('optConvertOpus') as HTMLInputElement)?.checked;
  if (state.processed.length > 0 && !optConvertOpus) {
    container.appendChild(mkBtn(getTranslation(state.currentLang, 'btnDownloadAll'), 'btn-success', downloadAllIndividual));
    if (state.processed.length > 1) {
      container.appendChild(mkBtn(getTranslation(state.currentLang, 'btnDownloadZip'), 'btn-primary', downloadAllZip));
    }
  }

  container.appendChild(mkBtn(getTranslation(state.currentLang, 'btnClearAll'), 'btn-ghost', clearAll));
}

function mkBtn(text: string, cls: string, handler: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn ${cls}`;
  b.textContent = text;
  b.addEventListener('click', handler);
  return b;
}

function showProgress(visible: boolean) {
  const s = getEl('progressSection');
  if (visible) {
    s.classList.remove('hidden');
    updateProgress(0, 'Iniciando...');
  } else {
    s.classList.add('hidden');
  }
}

function updateProgress(percent: number, text?: string) {
  const pct = Math.round(percent);
  getEl('progressFill').style.width = pct + '%';
  getEl('progressPercent').textContent = pct + '%';
  if (text) getEl('progressText').textContent = text;
}

function renderLog() {
  const panel = getEl('logPanel');
  if (state.logs.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  getEl('logCount').textContent = String(state.logs.length);
  const inner = getEl('logInner');

  while (inner.children.length < state.logs.length) {
    const entry = state.logs[inner.children.length];
    const el = document.createElement('div');
    el.className = 'log-entry';
    el.className = `log-entry log-${entry.type || 'info'}`;
    el.innerHTML = `<span class="log-time">${entry.time}</span><span>${esc(entry.msg)}</span>`;
    inner.appendChild(el);
  }

  const entries = getEl('logEntries');
  if (entries.classList.contains('open')) {
    entries.scrollTop = entries.scrollHeight;
  }
}

function renderResults() {
  const container = getEl('results');
  if (state.processed.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const optConvertOpus = (document.getElementById('optConvertOpus') as HTMLInputElement)?.checked;
  if (optConvertOpus) {
    const doneCount = state.processed.length;
    let descText = `Processamento local finalizado. ${doneCount} arquivo(s) convertidos com sucesso e salvos diretamente na pasta de saída.`;
    if (state.currentLang === 'en') {
      descText = `Local conversion completed. ${doneCount} file(s) successfully converted and saved directly to the output folder.`;
    }
    
    let html = `<div class="results-header"><h2>Conversão Local Concluída</h2><p>${esc(descText)}</p></div>`;
    container.innerHTML = html;
  } else {
    const doneCount = state.pairs.filter(p => p.status === 'done').length;
    const errCount = state.pairs.filter(p => p.status === 'error').length;
    const total = doneCount + errCount;
    const action = getTranslation(state.currentLang, state.mode === 'embed' ? 'resultsActionProcessed' : 'resultsActionExtracted');
    const errorPart = errCount > 0 ? getTranslation(state.currentLang, 'resultsDescErrorPart', errCount) : '';
    const descText = getTranslation(state.currentLang, 'resultsDesc', doneCount, total, action, errorPart);

    let html = `<div class="results-header"><h2>${esc(getTranslation(state.currentLang, 'resultsHeader'))}</h2><p>${esc(descText)}</p></div>`;
    html += '<div class="download-list">';
    for (const item of state.processed) {
      html += `<div class="download-item"><span class="file-name">🎵 ${esc(item.name)}</span><a href="${item.url}" download="${esc(item.name)}" class="download-btn">${esc(getTranslation(state.currentLang, 'downloadBtn'))}</a></div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  }

  renderActions();
}

function clearAll() {
  for (const p of state.processed) {
    if (p.url) URL.revokeObjectURL(p.url);
  }
  for (const flac of state.flacs.values()) {
    if (flac.coverUrl) URL.revokeObjectURL(flac.coverUrl);
  }
  state.flacs.clear();
  state.lrcs.clear();
  state.pairs = [];
  state.orphanFlacs = [];
  state.orphanLrcs = [];
  state.processed = [];
  state.logs = [];
  localStorage.removeItem('lyrics_embedder_logs');
  state.processing = false;
  pairIdCounter = 0;

  getEl('statsBar').classList.add('hidden');
  getEl('pairList').classList.add('hidden');
  getEl('actions').classList.add('hidden');
  getEl('verifyList').classList.add('hidden');
  getEl('verifyList').innerHTML = '';
  getEl('progressSection').classList.add('hidden');
  getEl('logPanel').classList.add('hidden');
  getEl('results').classList.add('hidden');
  getEl('logInner').innerHTML = '';
  (getEl('fileInput') as HTMLInputElement).value = '';
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 10: ALTERNADOR MODO ESCURO / CLARO
// ════════════════════════════════════════════════════════════════════════════

function initTheme() {
  const toggleBtn = getEl('themeToggle');
  const sunPath = getEl('themeSun');
  const moonPath = getEl('themeMoon');

  function setTheme(theme: 'light' | 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    if (theme === 'dark') {
      sunPath.classList.add('hidden');
      moonPath.classList.remove('hidden');
    } else {
      sunPath.classList.remove('hidden');
      moonPath.classList.add('hidden');
    }
  }

  toggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    setTheme(current === 'light' ? 'dark' : 'light');
  });

  const saved = localStorage.getItem('theme') as 'light' | 'dark' | null;
  if (saved) {
    setTheme(saved);
  } else {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(systemDark ? 'dark' : 'light');
  }
}

function initPalette() {
  const paletteToggleBtn = getEl('paletteToggle');
  const paletteMenu = getEl('paletteMenu');
  const paletteOptions = document.querySelectorAll('.palette-option');

  const albumToggleBtn = getEl('albumToggle');
  const albumMenu = getEl('albumMenu');
  const albumOptions = document.querySelectorAll('.album-option');

  const allPalettes = [
    'clay', 'sand', 'stone', 'onyx', 'neon', 'earth',
    'y2004', 'y2005', 'y2007', 'y2008', 'y2010', 'y2011', 'y2013', 'y2016', 'y2018a', 'y2018b', 'y2019', 'y2021', 'y2024a', 'y2024b'
  ];

  function setPalette(palette: string) {
    document.documentElement.setAttribute('data-palette', palette);
    localStorage.setItem('palette', palette);
    state.currentPalette = palette as any;

    const isAlbum = palette.startsWith('y');

    paletteOptions.forEach(opt => {
      if (!isAlbum && opt.getAttribute('data-palette') === palette) {
        opt.classList.add('active');
      } else {
        opt.classList.remove('active');
      }
    });

    albumOptions.forEach(opt => {
      if (isAlbum && opt.getAttribute('data-album') === palette) {
        opt.classList.add('active');
      } else {
        opt.classList.remove('active');
      }
    });

    const paletteLabelSpan = getEl('currentPaletteLabel');
    if (paletteLabelSpan) {
      if (isAlbum) {
        paletteLabelSpan.textContent = getTranslation(state.currentLang, 'paletteToggle');
      } else {
        let paletteNameKey = 'paletteClay';
        if (palette === 'sand') paletteNameKey = 'paletteSand';
        else if (palette === 'stone') paletteNameKey = 'paletteStone';
        else if (palette === 'onyx') paletteNameKey = 'paletteOnyx';
        else if (palette === 'neon') paletteNameKey = 'paletteNeon';
        else if (palette === 'earth') paletteNameKey = 'paletteEarth';
        paletteLabelSpan.textContent = getTranslation(state.currentLang, paletteNameKey as any);
      }
    }

    const albumLabelSpan = getEl('currentAlbumLabel');
    if (albumLabelSpan) {
      if (isAlbum) {
        albumLabelSpan.textContent = palette.substring(1);
      } else {
        albumLabelSpan.textContent = getTranslation(state.currentLang, 'albumToggle');
      }
    }
  }

  paletteToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    paletteMenu.classList.toggle('hidden');
    albumMenu.classList.add('hidden');
  });

  albumToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    albumMenu.classList.toggle('hidden');
    paletteMenu.classList.add('hidden');
  });

  paletteOptions.forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const newPalette = opt.getAttribute('data-palette');
      if (newPalette) {
        setPalette(newPalette);
      }
      paletteMenu.classList.add('hidden');
    });
  });

  albumOptions.forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const newAlbum = opt.getAttribute('data-album');
      if (newAlbum) {
        setPalette(newAlbum);
      }
      albumMenu.classList.add('hidden');
    });
  });

  window.addEventListener('click', () => {
    paletteMenu.classList.add('hidden');
    albumMenu.classList.add('hidden');
  });

  const saved = localStorage.getItem('palette');
  if (saved && allPalettes.includes(saved)) {
    setPalette(saved);
  } else {
    setPalette('clay');
  }
}

function initLanguage() {
  let lang: LangCode = 'pt-BR';
  const saved = localStorage.getItem('lang') as LangCode | null;
  if (saved && ['pt-BR', 'en', 'hi', 'ar', 'zh'].includes(saved)) {
    lang = saved;
  } else {
    const sysLang = navigator.language.toLowerCase();
    if (sysLang.startsWith('en')) lang = 'en';
    else if (sysLang.startsWith('hi')) lang = 'hi';
    else if (sysLang.startsWith('ar')) lang = 'ar';
    else if (sysLang.startsWith('zh')) lang = 'zh';
  }
  state.currentLang = lang;
  applyLanguage(lang);

  const toggleBtn = getEl('langToggle');
  const menu = getEl('langMenu');
  const options = document.querySelectorAll('.lang-option');

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });

  options.forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const newLang = opt.getAttribute('data-lang') as LangCode;
      if (newLang) {
        state.currentLang = newLang;
        localStorage.setItem('lang', newLang);
        applyLanguage(newLang);
      }
      menu.classList.add('hidden');
    });
  });

  window.addEventListener('click', () => {
    menu.classList.add('hidden');
  });
}

function applyLanguage(lang: LangCode) {
  if (lang === 'ar') {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.lang = 'ar';
  } else {
    document.documentElement.setAttribute('dir', 'ltr');
    document.documentElement.lang = lang;
  }

  const labelMap = { 'pt-BR': 'PT', 'en': 'EN', 'hi': 'HI', 'ar': 'AR', 'zh': 'ZH' };
  const currentLangLabel = getEl('currentLangLabel');
  if (currentLangLabel) {
    currentLangLabel.textContent = labelMap[lang] || 'PT';
  }

  translateUI();
  renderAll();
}

function translateUI() {
  const lang = state.currentLang;

  const subtitle = document.getElementById('headerSubtitle');
  if (subtitle) {
    subtitle.innerHTML = getTranslation(lang, 'headerSubtitle');
  }

  const squidText = document.querySelector('.header-link-btn span');
  if (squidText) {
    squidText.textContent = getTranslation(lang, 'squidBtn');
  }

  const paletteToggle = document.getElementById('paletteToggle');
  if (paletteToggle) {
    const labelSpan = document.getElementById('currentPaletteLabel');
    if (labelSpan) {
      const isAlbum = state.currentPalette.startsWith('y');
      if (isAlbum) {
        labelSpan.textContent = getTranslation(lang, 'paletteToggle');
      } else {
        let paletteNameKey = 'paletteClay';
        if (state.currentPalette === 'sand') paletteNameKey = 'paletteSand';
        else if (state.currentPalette === 'stone') paletteNameKey = 'paletteStone';
        else if (state.currentPalette === 'onyx') paletteNameKey = 'paletteOnyx';
        else if (state.currentPalette === 'neon') paletteNameKey = 'paletteNeon';
        else if (state.currentPalette === 'earth') paletteNameKey = 'paletteEarth';
        labelSpan.textContent = getTranslation(lang, paletteNameKey as any);
      }
    }
    paletteToggle.title = getTranslation(lang, 'paletteToggle');
  }

  const albumToggle = document.getElementById('albumToggle');
  if (albumToggle) {
    const labelSpan = document.getElementById('currentAlbumLabel');
    if (labelSpan) {
      const isAlbum = state.currentPalette.startsWith('y');
      if (isAlbum) {
        labelSpan.textContent = state.currentPalette.substring(1);
      } else {
        labelSpan.textContent = getTranslation(lang, 'albumToggle');
      }
    }
    albumToggle.title = getTranslation(lang, 'albumToggle');
  }

  const optClay = document.querySelector('.palette-option[data-palette="clay"]');
  if (optClay) optClay.textContent = getTranslation(lang, 'paletteClay');
  const optSand = document.querySelector('.palette-option[data-palette="sand"]');
  if (optSand) optSand.textContent = getTranslation(lang, 'paletteSand');
  const optStone = document.querySelector('.palette-option[data-palette="stone"]');
  if (optStone) optStone.textContent = getTranslation(lang, 'paletteStone');
  const optOnyx = document.querySelector('.palette-option[data-palette="onyx"]');
  if (optOnyx) optOnyx.textContent = getTranslation(lang, 'paletteOnyx');
  const optNeon = document.querySelector('.palette-option[data-palette="neon"]');
  if (optNeon) optNeon.textContent = getTranslation(lang, 'paletteNeon');
  const optEarth = document.querySelector('.palette-option[data-palette="earth"]');
  if (optEarth) optEarth.textContent = getTranslation(lang, 'paletteEarth');

  const tabEmbed = document.querySelector('.mode-tab[data-mode="embed"]');
  if (tabEmbed) tabEmbed.textContent = getTranslation(lang, 'tabEmbed');
  const tabExtract = document.querySelector('.mode-tab[data-mode="extract"]');
  if (tabExtract) tabExtract.textContent = getTranslation(lang, 'tabExtract');
  const tabVerify = document.querySelector('.mode-tab[data-mode="verify"]');
  if (tabVerify) tabVerify.textContent = getTranslation(lang, 'tabVerify');

  const dropText = document.getElementById('dropText');
  if (dropText) {
    if (state.mode === 'extract') {
      dropText.textContent = getTranslation(lang, 'dropTextExtract');
    } else if (state.mode === 'verify') {
      dropText.textContent = getTranslation(lang, 'dropTextVerify');
    } else {
      dropText.textContent = getTranslation(lang, 'dropTextDefault');
    }
  }

  const dropHint = document.getElementById('dropHint');
  if (dropHint) {
    dropHint.textContent = getTranslation(lang, 'dropHint');
  }

  const optTitle = document.querySelector('.options-title');
  if (optTitle) optTitle.textContent = getTranslation(lang, 'optionsTitle');

  const lblFetch = document.querySelector('label[for="optFetchLrc"]');
  if (lblFetch) lblFetch.textContent = getTranslation(lang, 'optFetchLrcLabel');
  const descFetch = document.querySelector('#rowFetchLrc .option-desc');
  if (descFetch) descFetch.textContent = getTranslation(lang, 'optFetchLrcDesc');

  const lblEmbed = document.querySelector('label[for="optEmbedLrc"]');
  if (lblEmbed) lblEmbed.textContent = getTranslation(lang, 'optEmbedLrcLabel');
  const descEmbed = document.querySelector('#rowEmbedLrc .option-desc');
  if (descEmbed) descEmbed.textContent = getTranslation(lang, 'optEmbedLrcDesc');

  const lblConvert = document.querySelector('label[for="optConvertOpus"]');
  if (lblConvert) lblConvert.textContent = getTranslation(lang, 'optConvertOpusLabel');
  const descConvert = document.querySelector('#rowConvertOpus .option-desc');
  if (descConvert) descConvert.textContent = getTranslation(lang, 'optConvertOpusDesc');

  const statsBar = getEl('statsBar');
  if (statsBar) {
    const labels = statsBar.querySelectorAll('.stat-label');
    if (labels.length >= 4) {
      labels[0].textContent = getTranslation(lang, 'statFlac');
      labels[1].textContent = getTranslation(lang, 'statLrc');
      labels[2].textContent = getTranslation(lang, 'statPaired');
      labels[3].textContent = getTranslation(lang, 'statOrphan');
    }
  }

  const logToggle = document.getElementById('logToggle');
  if (logToggle && logToggle.firstElementChild) {
    logToggle.firstElementChild.innerHTML = `${getTranslation(lang, 'logTitle')} (<span id="logCount">${state.logs.length}</span> ${getTranslation(lang, 'logEntries')})`;
  }
  const btnClearLogs = document.getElementById('btnClearLogs');
  if (btnClearLogs) btnClearLogs.textContent = getTranslation(lang, 'btnClearLogs');

  const footerText = document.getElementById('footerText');
  if (footerText) footerText.textContent = getTranslation(lang, 'footerText');

  const btnStartLocalBatch = document.getElementById('btnStartLocalBatch');
  if (btnStartLocalBatch) {
    btnStartLocalBatch.textContent = getTranslation(lang, 'btnStartLocalBatch' as any);
  }
}



function initOpusEngineListeners() {
  const optConvertOpus = getEl<HTMLInputElement>('optConvertOpus');
  const opusEngineSection = getEl<HTMLElement>('opusEngineSection');

  const updateVisibility = () => {
    const dropzone = getEl('dropzone');
    const statsBar = getEl('statsBar');
    const actions = getEl('actions');
    const pairList = getEl('pairList');
    const verifyList = getEl('verifyList');

    if (optConvertOpus.checked) {
      opusEngineSection.classList.remove('hidden');
      dropzone.classList.add('hidden');
      statsBar.classList.add('hidden');
      actions.classList.add('hidden');
      pairList.classList.add('hidden');
      verifyList.classList.add('hidden');
      checkLocalServerStatus();
    } else {
      opusEngineSection.classList.add('hidden');
      dropzone.classList.remove('hidden');
      renderAll();
    }
  };

  optConvertOpus.addEventListener('change', updateVisibility);

  const localInputDir = getEl<HTMLInputElement>('localInputDir');
  const localOutputDir = getEl<HTMLInputElement>('localOutputDir');
  localInputDir.value = localStorage.getItem('lyrics_embedder_local_input') || '';
  localOutputDir.value = localStorage.getItem('lyrics_embedder_local_output') || '';

  const saveLocalFoldersToServer = async () => {
    const inputDir = localInputDir.value.trim();
    const outputDir = localOutputDir.value.trim();
    try {
      await fetch("http://localhost:8000/api/config", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ INPUT_DIR: inputDir, OUTPUT_DIR: outputDir }),
        mode: 'cors'
      });
    } catch (err) {
      console.error("Falha ao salvar pastas no servidor local:", err);
    }
  };

  localInputDir.addEventListener('input', () => {
    localStorage.setItem('lyrics_embedder_local_input', localInputDir.value);
    saveLocalFoldersToServer();
  });
  localOutputDir.addEventListener('input', () => {
    localStorage.setItem('lyrics_embedder_local_output', localOutputDir.value);
    saveLocalFoldersToServer();
  });

  const btnStartLocalBatch = document.getElementById('btnStartLocalBatch');
  if (btnStartLocalBatch) {
    btnStartLocalBatch.addEventListener('click', () => {
      runLocalConversionBatch();
    });
  }

  updateVisibility();
}

async function checkLocalServerStatus(): Promise<boolean> {
  const localServerStatus = getEl<HTMLElement>('localServerStatus');
  if (!localServerStatus) return false;
  
  try {
    const res = await fetch("http://localhost:8000/api/config", { method: 'GET', mode: 'cors' });
    if (res.ok) {
      const data = await res.json();
      localServerStatus.innerHTML = '<span style="color: var(--ok)">● Servidor local online (Porta 8000)</span>';
      
      const localInputDir = getEl<HTMLInputElement>('localInputDir');
      const localOutputDir = getEl<HTMLInputElement>('localOutputDir');
      
      if (data.INPUT_DIR !== undefined && data.INPUT_DIR !== localInputDir.value) {
        localInputDir.value = data.INPUT_DIR;
        localStorage.setItem('lyrics_embedder_local_input', data.INPUT_DIR);
      }
      if (data.OUTPUT_DIR !== undefined && data.OUTPUT_DIR !== localOutputDir.value) {
        localOutputDir.value = data.OUTPUT_DIR;
        localStorage.setItem('lyrics_embedder_local_output', data.OUTPUT_DIR);
      }
      return true;
    }
  } catch (err) {
    // Falhou
  }
  localServerStatus.innerHTML = '<span style="color: var(--warn)">● Servidor local offline. Rode "python conversor/convert.py" no terminal.</span>';
  return false;
}

async function runLocalConversionBatch() {
  const isOnline = await checkLocalServerStatus();
  if (!isOnline) {
    addLog('err', "Erro: Servidor local offline. Não é possível iniciar a conversão local.");
    alert("Erro: O servidor local está offline. Por favor, execute 'python conversor/convert.py' no terminal.");
    return;
  }

  const inputDir = getEl<HTMLInputElement>('localInputDir').value.trim();
  const outputDir = getEl<HTMLInputElement>('localOutputDir').value.trim();

  if (!inputDir) {
    addLog('err', "Erro: Caminho da Pasta de Entrada é obrigatório para conversão local.");
    alert("Por favor, informe o Caminho da Pasta de Entrada contendo os arquivos FLAC.");
    return;
  }

  try {
    state.processing = true;
    showProgress(true);
    updateProgress(0);
    state.processed = [];

    // Inicializar os campos de detalhes de progresso
    const progressText = document.getElementById('progressText');
    if (progressText) progressText.textContent = "Iniciando conversão local...";
    
    const progressCurrentFile = document.getElementById('progressCurrentFile');
    if (progressCurrentFile) progressCurrentFile.textContent = "Escaneando...";
    
    const progressCountText = document.getElementById('progressCountText');
    if (progressCountText) progressCountText.textContent = "0 / 0";
    
    const progressRemainingText = document.getElementById('progressRemainingText');
    if (progressRemainingText) progressRemainingText.textContent = "0";
    
    const progressErrorsText = document.getElementById('progressErrorsText');
    if (progressErrorsText) progressErrorsText.textContent = "0";

    const progressLastLog = document.getElementById('progressLastLog');
    if (progressLastLog) progressLastLog.textContent = "Enviando comando para o servidor local...";

    const res = await fetch("http://localhost:8000/api/convert", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_dir: inputDir, output_dir: outputDir }),
      mode: 'cors'
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || "Erro desconhecido do servidor");
    }

    addLog('info', "Conversão em lote local iniciada. Escaneando pastas...");
    if (progressLastLog) progressLastLog.textContent = "Servidor escaneando pasta de arquivos FLAC...";

    let lastLogIdx = 0;
    const pollInterval = setInterval(async () => {
      try {
        const statusRes = await fetch("http://localhost:8000/api/status", { method: 'GET', mode: 'cors' });
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          
          const done = statusData.done;
          const errors = statusData.errors;
          const skipped = statusData.skipped;
          const total = statusData.total;
          const currentFile = statusData.current_file;
          const serverLogs = statusData.log_entries || [];

          for (let i = lastLogIdx; i < serverLogs.length; i++) {
            const logLine = serverLogs[i];
            if (logLine.startsWith("Sucesso:")) {
              addLog('ok', logLine);
            } else if (logLine.startsWith("Erro:") || logLine.startsWith("Falha:")) {
              addLog('err', logLine);
            } else {
              addLog('info', logLine);
            }
            if (progressLastLog) {
              progressLastLog.textContent = logLine;
            }
          }
          lastLogIdx = serverLogs.length;

          const processed = done + errors + skipped;
          const pct = total > 0 ? (processed / total) * 100 : 0;
          updateProgress(pct);

          // Atualizar os novos detalhes do progresso
          if (progressText) {
            progressText.textContent = statusData.processing ? "Processando lote local..." : "Concluído";
          }

          if (progressCurrentFile) {
            progressCurrentFile.textContent = currentFile || (statusData.processing ? "Escaneando..." : "Nenhum");
          }

          if (progressCountText) {
            progressCountText.textContent = `${processed} / ${total}`;
          }

          if (progressRemainingText) {
            progressRemainingText.textContent = String(total - processed);
          }

          if (progressErrorsText) {
            progressErrorsText.textContent = String(errors);
          }

          if (!statusData.processing) {
            clearInterval(pollInterval);
            state.processing = false;
            showProgress(false);
            
            for (let i = 0; i < done; i++) {
              state.processed.push({ name: `LocalFile_${i + 1}.opus`, blob: new Blob(), url: '' });
            }
            
            addLog('ok', `Lote local finalizado: ${done} com sucesso, ${errors} erros, ${skipped} ignorados.`);
            renderResults();
            renderAll();
          }
        }
      } catch (pollErr: any) {
        console.error("Erro no polling de progresso:", pollErr);
        clearInterval(pollInterval);
        state.processing = false;
        showProgress(false);
        addLog('err', `Erro de conexão com o servidor local: ${pollErr.message}`);
      }
    }, 1000);

  } catch (err: any) {
    state.processing = false;
    showProgress(false);
    addLog('err', `Falha ao iniciar conversão local: ${err.message}`);
    alert(`Erro ao iniciar conversão local: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 11: EVENT LISTENERS
// ════════════════════════════════════════════════════════════════════════════

function initEventListeners() {
  // Mode tabs
  getEl('modeTabs').addEventListener('click', async (e) => {
    const tab = (e.target as HTMLElement).closest('.mode-tab');
    if (!tab || tab.classList.contains('active')) return;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.mode = tab.getAttribute('data-mode') as 'embed' | 'extract' | 'verify';

    const dropText = getEl('dropText');
    const dropBadges = getEl('dropBadges');
    const fileInput = getEl('fileInput') as HTMLInputElement;

    if (state.mode === 'extract') {
      dropText.textContent = getTranslation(state.currentLang, 'dropTextExtract');
      dropBadges.innerHTML = '<span class="badge badge-flac">.flac</span>';
      fileInput.accept = '.flac';
      getEl('optionsCard').classList.add('hidden');
    } else if (state.mode === 'verify') {
      dropText.textContent = getTranslation(state.currentLang, 'dropTextVerify');
      dropBadges.innerHTML = '<span class="badge badge-flac">.flac</span>';
      fileInput.accept = '.flac';
      getEl('optionsCard').classList.remove('hidden');
      getEl('rowFetchLrc').classList.add('hidden');
      getEl('rowEmbedLrc').classList.add('hidden');
      getEl('rowConvertOpus').classList.remove('hidden');
    } else {
      dropText.textContent = getTranslation(state.currentLang, 'dropTextDefault');
      dropBadges.innerHTML = '<span class="badge badge-flac">.flac</span><span class="badge badge-lrc">.lrc</span>';
      fileInput.accept = '.flac,.lrc';
      getEl('optionsCard').classList.remove('hidden');
      getEl('rowFetchLrc').classList.remove('hidden');
      getEl('rowEmbedLrc').classList.remove('hidden');
      getEl('rowConvertOpus').classList.remove('hidden');
    }

    if (state.flacs.size > 0) {
      if (state.mode === 'extract') {
        await prepareExtractMode();
      } else if (state.mode === 'verify') {
        await prepareVerifyMode();
      } else {
        createPairs();
      }
      renderAll();
    }
    getEl('modeTabs').setAttribute('data-active', state.mode);
  });

  // Dropzone events
  const dropzone = getEl('dropzone');
  const fileInput = getEl('fileInput') as HTMLInputElement;

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      registerFiles(fileInput.files);
    }
  });

  dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (!dropzone.contains(e.relatedTarget as Node)) {
      dropzone.classList.remove('drag-over');
    }
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer?.files) {
      const valid: File[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const f = e.dataTransfer.files[i];
        const ext = f.name.split('.').pop()?.toLowerCase();
        if (ext === 'flac' || ext === 'lrc') {
          valid.push(f);
        }
      }
      if (valid.length > 0) {
        registerFiles(valid);
      }
    }
  });

  // Prevent default drag on window
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  // Log toggle click
  getEl('logToggle').addEventListener('click', () => {
    getEl('logToggle').classList.toggle('open');
    getEl('logEntries').classList.toggle('open');
  });

  // Clear logs click
  getEl('btnClearLogs').addEventListener('click', (e) => {
    e.stopPropagation(); // Evita expandir/recolher o painel de logs
    state.logs = [];
    localStorage.removeItem('lyrics_embedder_logs');
    getEl('logInner').innerHTML = '';
    renderLog();
  });

  initOpusEngineListeners();
}

// ════════════════════════════════════════════════════════════════════════════
// SEÇÃO 12: INICIALIZAÇÃO
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initPalette();
  initLanguage();
  initEventListeners();
  loadLogsFromStorage();
  if (state.logs.length === 0) {
    addLog('info', getTranslation(state.currentLang, 'logLoad'));
  } else {
    addLog('info', getTranslation(state.currentLang, 'logRestore'));
    renderLog();
  }
  getEl('modeTabs').setAttribute('data-active', state.mode);
});
