'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const audio = $('#audio');
const fileInput = $('#fileInput');
const DB_NAME = 'aura-player';
const STORE = 'tracks';

const state = {
  tracks: [],
  queue: JSON.parse(localStorage.getItem('aura-queue') || '[]'),
  currentId: localStorage.getItem('aura-current') || null,
  currentUrl: null,
  filter: 'all',
  sort: 'recent',
  search: '',
  repeat: localStorage.getItem('aura-repeat') || 'off',
  shuffle: localStorage.getItem('aura-shuffle') === 'true',
  menuTrackId: null,
  sleepTimeout: null,
  sleepEndsAt: null,
  coverUrls: new Map()
};

const accents = {
  lime: ['#d9ff55', '217,255,85'],
  coral: ['#ff775f', '255,119,95'],
  violet: ['#9d8cff', '157,140,255'],
  cyan: ['#55dfff', '85,223,255']
};

let db;
let toastTimer;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbAction(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const request = action(store);
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || request.error || new Error('Транзакция хранилища отменена'));
    tx.onerror = () => reject(tx.error || request.error || new Error('Ошибка локального хранилища'));
  });
}

const getAllTracks = () => dbAction('readonly', store => store.getAll());
const saveTrack = track => dbAction('readwrite', store => store.put(track));
const removeTrack = id => dbAction('readwrite', store => store.delete(id));
const clearTracks = () => dbAction('readwrite', store => store.clear());

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  return `${mins}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}

function colorFor(id) {
  const palettes = [
    ['#d9ff55', '#22271b'], ['#ff775f', '#2a1b1a'], ['#9d8cff', '#201d2b'],
    ['#55dfff', '#17262a'], ['#ffca55', '#282318'], ['#ff75bd', '#291b24']
  ];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palettes[Math.abs(hash) % palettes.length];
}

function splitFilename(name) {
  const clean = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const parts = clean.split(/\s[-–—]\s/);
  if (parts.length > 1) return { artist: parts.shift().trim(), title: parts.join(' — ').trim() };
  return { artist: 'Неизвестный исполнитель', title: clean || 'Без названия' };
}

function inferMediaType(file) {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const types = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', m4v: 'video/mp4',
    mov: 'video/quicktime', webm: 'video/webm'
  };
  return types[extension] || 'application/octet-stream';
}

function synchsafe(bytes) {
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f);
}

function decodeText(bytes, encoding = 0) {
  if (!bytes.length) return '';
  try {
    if (encoding === 1 || encoding === 2) {
      const little = encoding === 1 && bytes[0] === 0xff && bytes[1] === 0xfe;
      const start = encoding === 1 && (bytes[0] === 0xff || bytes[0] === 0xfe) ? 2 : 0;
      const view = bytes.slice(start);
      if (little) {
        for (let i = 0; i + 1 < view.length; i += 2) [view[i], view[i + 1]] = [view[i + 1], view[i]];
      }
      return new TextDecoder('utf-16be').decode(view).replace(/\0/g, '').trim();
    }
    return new TextDecoder(encoding === 3 ? 'utf-8' : 'iso-8859-1').decode(bytes).replace(/\0/g, '').trim();
  } catch { return ''; }
}

function apicBlob(frame) {
  const encoding = frame[0];
  let index = 1;
  let mimeEnd = frame.indexOf(0, index);
  if (mimeEnd < 0) return null;
  const mime = new TextDecoder('ascii').decode(frame.slice(index, mimeEnd)) || 'image/jpeg';
  index = mimeEnd + 2;
  const doubleNull = encoding === 1 || encoding === 2;
  while (index < frame.length - 1) {
    if (frame[index] === 0 && (!doubleNull || frame[index + 1] === 0)) {
      index += doubleNull ? 2 : 1;
      break;
    }
    index += doubleNull ? 2 : 1;
  }
  return index < frame.length ? new Blob([frame.slice(index)], { type: mime }) : null;
}

async function readId3(file) {
  const result = {};
  try {
    const buffer = await file.slice(0, Math.min(file.size, 3 * 1024 * 1024)).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (String.fromCharCode(...bytes.slice(0, 3)) !== 'ID3') return result;
    const version = bytes[3];
    const tagEnd = Math.min(bytes.length, 10 + synchsafe(bytes.slice(6, 10)));
    let pos = 10;
    while (pos + 10 <= tagEnd) {
      const id = String.fromCharCode(...bytes.slice(pos, pos + 4));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const sizeBytes = bytes.slice(pos + 4, pos + 8);
      const size = version === 4 ? synchsafe(sizeBytes) : new DataView(sizeBytes.buffer, sizeBytes.byteOffset, 4).getUint32(0);
      if (!size || pos + 10 + size > bytes.length) break;
      const frame = bytes.slice(pos + 10, pos + 10 + size);
      if (id === 'TIT2') result.title = decodeText(frame.slice(1), frame[0]);
      if (id === 'TPE1') result.artist = decodeText(frame.slice(1), frame[0]);
      if (id === 'TALB') result.album = decodeText(frame.slice(1), frame[0]);
      if (id === 'APIC' && !result.cover) result.cover = apicBlob(frame);
      pos += 10 + size;
    }
  } catch (error) { console.warn('Не удалось прочитать ID3', error); }
  return result;
}

function getDuration(file) {
  return new Promise(resolve => {
    const probe = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const finish = value => { URL.revokeObjectURL(url); probe.removeAttribute('src'); resolve(Number.isFinite(value) ? value : 0); };
    const timeout = setTimeout(() => finish(0), 6000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => { clearTimeout(timeout); finish(probe.duration); };
    probe.onerror = () => { clearTimeout(timeout); finish(0); };
    probe.src = url;
  });
}

async function createTrack(file) {
  const fallback = splitFilename(file.name);
  // iOS may expose a picker File backed by a temporary system URL. Copy its
  // bytes into a plain Blob before persisting so IndexedDB owns stable data.
  const stableBlob = new Blob([await file.arrayBuffer()], { type: inferMediaType(file) });
  const [tags, duration] = await Promise.all([readId3(stableBlob), getDuration(stableBlob)]);
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    title: tags.title || fallback.title,
    artist: tags.artist || fallback.artist,
    album: tags.album || '',
    duration,
    size: stableBlob.size,
    type: stableBlob.type,
    added: Date.now(),
    favorite: false,
    file: stableBlob,
    cover: tags.cover || null
  };
}

function getCoverUrl(track) {
  if (!track?.cover) return null;
  if (!state.coverUrls.has(track.id)) state.coverUrls.set(track.id, URL.createObjectURL(track.cover));
  return state.coverUrls.get(track.id);
}

function coverStyle(track) {
  const image = getCoverUrl(track);
  const [accent, bg] = colorFor(track.id);
  return image ? `background-image:url('${image}')` : `--cover-accent:${accent};--cover-bg:${bg}`;
}

async function importFiles(files) {
  const mediaFiles = [...files].filter(file =>
    file.type.startsWith('audio/') || file.type.startsWith('video/') ||
    /\.(mp3|m4a|aac|wav|ogg|flac|mp4|mov|m4v|webm)$/i.test(file.name)
  );
  if (!mediaFiles.length) return showToast('Выбери аудио или видео');
  showToast(`Добавляю ${mediaFiles.length} ${mediaFiles.length === 1 ? 'файл' : 'файлов'}…`);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  let imported = 0;
  let lastError = null;
  for (const file of mediaFiles) {
    try {
      const track = await createTrack(file);
      await saveTrack(track);
      state.tracks.unshift(track);
      imported++;
    } catch (error) {
      console.error(error);
      lastError = error;
      if (error?.name === 'QuotaExceededError') {
        showToast('Не хватает памяти на устройстве');
        break;
      }
    }
  }
  if (!state.currentId && state.tracks[0]) {
    state.currentId = state.tracks[0].id;
    state.queue = state.tracks.map(track => track.id);
    persistPlayerState();
    await loadCurrent(false);
  }
  renderAll();
  if (imported) showToast(`Добавлено: ${imported}`);
  else if (lastError?.name === 'QuotaExceededError') showToast('Не хватает памяти для этого трека');
  else showToast('Не удалось сохранить файл. Попробуй MP3, MP4 или MOV');
  fileInput.value = '';
}

function persistPlayerState() {
  localStorage.setItem('aura-queue', JSON.stringify(state.queue));
  if (state.currentId) localStorage.setItem('aura-current', state.currentId);
  localStorage.setItem('aura-repeat', state.repeat);
  localStorage.setItem('aura-shuffle', String(state.shuffle));
}

function currentTrack() { return state.tracks.find(track => track.id === state.currentId) || null; }

function filteredTracks() {
  const query = state.search.toLocaleLowerCase('ru');
  let list = state.tracks.filter(track =>
    state.filter === 'all' ||
    (state.filter === 'favorites' && track.favorite) ||
    (state.filter === 'video' && track.type?.startsWith('video/'))
  );
  if (query) list = list.filter(track => `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase('ru').includes(query));
  return [...list].sort((a, b) => state.sort === 'title' ? a.title.localeCompare(b.title, 'ru') : b.added - a.added);
}

function trackRow(track, index, queue = false) {
  const current = track.id === state.currentId;
  return `<div class="track-row${current ? ' current' : ''}" data-id="${track.id}">
    <span class="track-index">${current && !audio.paused ? '▶' : String(index + 1).padStart(2, '0')}</span>
    <div class="row-cover" style="${coverStyle(track)}">${getCoverUrl(track) ? '' : `<span>${escapeHtml(track.title.charAt(0).toUpperCase())}</span>`}</div>
    <div class="row-title"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></div>
    ${queue ? '' : `<span class="track-duration">${formatTime(track.duration)}</span>`}
    <button class="more-button" data-menu="${track.id}" aria-label="Действия с треком">•••</button>
  </div>`;
}

function circleCard(track) {
  const cover = getCoverUrl(track);
  return `<button class="circle-track" data-circle-id="${track.id}">
    <span class="circle-cover" style="${coverStyle(track)}">${cover ? '' : escapeHtml(track.title.charAt(0).toUpperCase())}</span>
    <strong>${escapeHtml(track.title)}</strong>
    <small>${escapeHtml(track.artist)}</small>
  </button>`;
}

function renderTrackLists() {
  const recent = [...state.tracks].sort((a, b) => b.added - a.added).slice(0, 4);
  $('#recentTracks').innerHTML = recent.map(trackRow).join('');
  $('#homeEmpty').classList.toggle('show', state.tracks.length === 0);
  $('#recentTracks').hidden = state.tracks.length === 0;

  const favorites = state.tracks.filter(track => track.favorite).slice(0, 8);
  $('#favoriteTracks').innerHTML = favorites.length
    ? favorites.map(circleCard).join('')
    : `<button class="circle-track circle-placeholder" data-favorites-empty><span class="circle-cover">☆</span><strong>Добавь любимые</strong><small>Нажми ••• у трека</small></button>`;

  const library = filteredTracks();
  $('#libraryTracks').innerHTML = library.map(trackRow).join('');
  $('#libraryEmpty').classList.toggle('show', library.length === 0);
  $('#trackCount').textContent = state.tracks.length;

  state.queue = state.queue.filter(id => state.tracks.some(track => track.id === id));
  const queueTracks = state.queue.map(id => state.tracks.find(track => track.id === id)).filter(Boolean);
  $('#queueTracks').innerHTML = queueTracks.map((track, index) => trackRow(track, index, true)).join('');
  $('#queueEmpty').classList.toggle('show', queueTracks.length === 0);
  $('#queueCount').textContent = queueTracks.length;
}

function renderPlayer() {
  const track = currentTrack();
  const isPlaying = track && !audio.paused;
  const fullPlayer = $('#fullPlayer');
  $('#nowCard').classList.toggle('playing', isPlaying);
  $('#miniPlayer').classList.toggle('playing', isPlaying);
  $('#playButton').classList.toggle('playing', isPlaying);
  $('#miniPlay').classList.toggle('playing', isPlaying);
  fullPlayer.classList.toggle('playing', isPlaying);
  $('#fullPlay').classList.toggle('playing', isPlaying);
  $('#shuffleButton').classList.toggle('active', state.shuffle);
  $('#fullShuffle').classList.toggle('active', state.shuffle);
  $('#repeatButton').dataset.mode = state.repeat;
  $('#repeatButton').classList.toggle('active', state.repeat !== 'off');
  $('#repeatButton').setAttribute('aria-label', state.repeat === 'one' ? 'Повтор одного трека' : state.repeat === 'all' ? 'Повтор очереди' : 'Повтор выключен');
  if (!track) {
    $('#miniPlayer').classList.add('hidden');
    if (fullPlayer.open) fullPlayer.close();
    return;
  }
  $('#nowCard').classList.remove('idle');
  $('#nowTitle').textContent = track.title;
  $('#nowArtist').textContent = track.album ? `${track.artist} • ${track.album}` : track.artist;
  $('#miniTitle').textContent = track.title;
  $('#miniArtist').textContent = track.artist;
  $('#fullTitle').textContent = track.title;
  $('#fullArtist').textContent = track.album ? `${track.artist} • ${track.album}` : track.artist;
  $('#fullFavorite').textContent = track.favorite ? '★' : '☆';
  $('#fullFavorite').classList.toggle('active', track.favorite);
  $('.play-label').textContent = isPlaying ? 'Пауза' : 'Слушать';
  const cover = getCoverUrl(track);
  const [accent, bg] = colorFor(track.id);
  for (const element of [$('#coverArt'), $('#miniCover'), $('#fullCover')]) {
    element.style.backgroundImage = cover ? `url('${cover}')` : '';
    element.style.backgroundColor = cover ? '' : bg;
    element.style.color = accent;
  }
  $('.cover-monogram').textContent = cover ? '' : track.title.charAt(0).toUpperCase();
  $('.cover-orbit').style.display = cover ? 'none' : '';
  $('#miniCover').textContent = cover ? '' : track.title.charAt(0).toUpperCase();
  $('#fullCover').textContent = cover ? '' : track.title.charAt(0).toUpperCase();
  fullPlayer.style.setProperty('--player-accent', accent);
  fullPlayer.style.setProperty('--player-bg', bg);
  $('#miniPlayer').classList.toggle('hidden', fullPlayer.open);
}

function renderStorage() {
  const used = state.tracks.reduce((sum, track) => sum + (track.size || 0) + (track.cover?.size || 0), 0);
  $('#storageUsed').textContent = formatBytes(used);
  if (navigator.storage?.estimate) navigator.storage.estimate().then(({ quota = 1 }) => {
    $('#storageFill').style.width = `${Math.min(100, used / quota * 100)}%`;
  });
}

function renderAll() {
  renderTrackLists();
  renderPlayer();
  renderStorage();
  persistPlayerState();
}

function setupWaveform() {
  const wave = $('#waveform');
  let seed = 9;
  wave.innerHTML = Array.from({ length: 68 }, (_, i) => {
    seed = (seed * 9301 + 49297) % 233280;
    const h = 12 + (seed / 233280) * 88;
    return `<i style="--h:${h.toFixed(0)}" data-i="${i}"></i>`;
  }).join('');
}

async function loadCurrent(shouldPlay = false) {
  const track = currentTrack();
  if (!track) return;
  if (state.currentUrl) URL.revokeObjectURL(state.currentUrl);
  state.currentUrl = URL.createObjectURL(track.file);
  audio.src = state.currentUrl;
  audio.load();
  updateMediaSession(track);
  renderAll();
  if (shouldPlay) {
    try { await audio.play(); } catch (error) { console.warn('Воспроизведение ждёт нажатия пользователя', error); }
  }
}

async function playTrack(id, rebuildQueue = true) {
  const track = state.tracks.find(item => item.id === id);
  if (!track) return;
  if (rebuildQueue && !state.queue.includes(id)) state.queue = filteredTracks().map(item => item.id);
  state.currentId = id;
  persistPlayerState();
  await loadCurrent(true);
}

async function togglePlay() {
  if (!currentTrack()) {
    if (!state.tracks.length) return fileInput.click();
    state.currentId = state.tracks[0].id;
    state.queue = state.tracks.map(track => track.id);
    await loadCurrent(true);
    return;
  }
  if (audio.paused) {
    try { await audio.play(); } catch { showToast('Нажми ещё раз для воспроизведения'); }
  } else audio.pause();
}

function nextId(direction = 1) {
  if (!state.queue.length) state.queue = state.tracks.map(track => track.id);
  if (!state.queue.length) return null;
  let index = state.queue.indexOf(state.currentId);
  if (state.shuffle && state.queue.length > 1 && direction > 0) {
    let next;
    do next = Math.floor(Math.random() * state.queue.length); while (next === index);
    return state.queue[next];
  }
  index += direction;
  if (index >= state.queue.length) return state.repeat === 'all' ? state.queue[0] : null;
  if (index < 0) return state.queue[state.queue.length - 1];
  return state.queue[index];
}

async function changeTrack(direction) {
  if (direction < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  const id = nextId(direction);
  if (id) await playTrack(id, false);
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  const artwork = getCoverUrl(track);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album || 'AURA',
    artwork: artwork ? [{ src: artwork, sizes: '512x512' }] : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }]
  });
}

function updateProgress() {
  const duration = Number.isFinite(audio.duration) ? audio.duration : currentTrack()?.duration || 0;
  const progress = duration ? audio.currentTime / duration : 0;
  $('#currentTime').textContent = formatTime(audio.currentTime);
  $('#duration').textContent = formatTime(duration);
  $('#fullCurrentTime').textContent = formatTime(audio.currentTime);
  $('#fullDuration').textContent = `-${formatTime(Math.max(0, duration - audio.currentTime))}`;
  $('#seekBar').value = Math.round(progress * 1000);
  $('#fullSeekBar').value = Math.round(progress * 1000);
  $('#seekBar').style.setProperty('--progress', `${progress * 100}%`);
  $('#fullSeekBar').style.setProperty('--progress', `${progress * 100}%`);
  $('#miniProgress').style.width = `${progress * 100}%`;
  const bars = $$('#waveform i');
  bars.forEach((bar, index) => bar.classList.toggle('passed', index / bars.length <= progress));
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && duration > 0) {
    try { navigator.mediaSession.setPositionState({ duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, duration) }); } catch { /* Safari can reject while metadata settles */ }
  }
}

function navigate(name) {
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `${name}View`));
  $$('.bottom-nav button').forEach(button => button.classList.toggle('active', button.dataset.nav === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderPlayer();
}

function applyFilter(filter) {
  state.filter = filter;
  state.sort = 'recent';
  $('#sortButton').textContent = 'ПО ДАТЕ ↓';
  $$('.segmented button').forEach(button => button.classList.toggle('active', button.dataset.filter === filter));
  navigate('library');
  renderTrackLists();
}

function openFullPlayer() {
  if (!currentTrack()) {
    fileInput.click();
    return;
  }
  if (!$('#fullPlayer').open) $('#fullPlayer').showModal();
  renderPlayer();
  updateProgress();
}

function closeFullPlayer() {
  if ($('#fullPlayer').open) $('#fullPlayer').close();
  renderPlayer();
}

function openTrackMenu(id) {
  const track = state.tracks.find(item => item.id === id);
  if (!track) return;
  state.menuTrackId = id;
  $('#sheetTitle').textContent = track.title;
  $('#sheetArtist').textContent = track.artist;
  const cover = getCoverUrl(track);
  const [accent, bg] = colorFor(track.id);
  $('#sheetCover').style.backgroundImage = cover ? `url('${cover}')` : '';
  $('#sheetCover').style.backgroundColor = cover ? '' : bg;
  $('#sheetCover').style.color = accent;
  $('#sheetCover').textContent = cover ? '' : track.title.charAt(0).toUpperCase();
  const favoriteButton = $('#trackMenu [data-action=favorite]');
  favoriteButton.querySelector('span').textContent = track.favorite ? '♥' : '♡';
  favoriteButton.querySelector('b').textContent = track.favorite ? 'Убрать из любимых' : 'Добавить в любимые';
  $('#trackMenu').showModal();
}

async function handleTrackAction(action) {
  const track = state.tracks.find(item => item.id === state.menuTrackId);
  if (action === 'close') return $('#trackMenu').close();
  if (!track) return;
  if (action === 'favorite') {
    track.favorite = !track.favorite;
    await saveTrack(track);
    showToast(track.favorite ? 'Добавлено в любимые' : 'Убрано из любимых');
  }
  if (action === 'play-next') {
    state.queue = state.queue.filter(id => id !== track.id);
    const currentIndex = Math.max(0, state.queue.indexOf(state.currentId));
    state.queue.splice(currentIndex + 1, 0, track.id);
    showToast('Трек будет следующим');
  }
  if (action === 'rename') {
    const title = prompt('Название трека', track.title)?.trim();
    if (title) {
      const artist = prompt('Исполнитель', track.artist)?.trim();
      track.title = title;
      if (artist) track.artist = artist;
      await saveTrack(track);
      if (track.id === state.currentId) updateMediaSession(track);
    }
  }
  if (action === 'delete') {
    if (!confirm(`Удалить «${track.title}» с этого устройства?`)) return;
    await removeTrack(track.id);
    state.tracks = state.tracks.filter(item => item.id !== track.id);
    state.queue = state.queue.filter(id => id !== track.id);
    const cover = state.coverUrls.get(track.id);
    if (cover) URL.revokeObjectURL(cover);
    state.coverUrls.delete(track.id);
    if (state.currentId === track.id) {
      audio.pause();
      state.currentId = state.queue[0] || state.tracks[0]?.id || null;
      if (state.currentId) await loadCurrent(false);
      else { audio.removeAttribute('src'); localStorage.removeItem('aura-current'); }
    }
    showToast('Трек удалён');
  }
  $('#trackMenu').close();
  renderAll();
}

function setAccent(name) {
  const [color, rgb] = accents[name] || accents.lime;
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-rgb', rgb);
  localStorage.setItem('aura-accent', name);
  $$('#accentPicker button').forEach(button => button.classList.toggle('active', button.dataset.accent === name));
}

function setSleepTimer(minutes) {
  clearTimeout(state.sleepTimeout);
  state.sleepEndsAt = minutes ? Date.now() + minutes * 60000 : null;
  $('#sleepTimerLabel').textContent = minutes ? `${minutes} мин.` : 'Выключен';
  if (minutes) state.sleepTimeout = setTimeout(() => {
    audio.pause();
    state.sleepEndsAt = null;
    $('#sleepTimerLabel').textContent = 'Выключен';
    showToast('Таймер сна остановил музыку');
  }, minutes * 60000);
  $('#timerMenu').close();
  showToast(minutes ? `Таймер: ${minutes} мин.` : 'Таймер выключен');
}

function bindEvents() {
  ['#addTracksHero', '#addTracksEmpty', '#addTracksLibrary'].forEach(selector => $(selector).addEventListener('click', () => fileInput.click()));
  fileInput.addEventListener('change', event => importFiles(event.target.files));
  ['#playButton', '#miniPlay', '#fullPlay'].forEach(selector => $(selector).addEventListener('click', togglePlay));
  ['#nextButton', '#miniNext', '#fullNext'].forEach(selector => $(selector).addEventListener('click', () => changeTrack(1)));
  ['#prevButton', '#fullPrev'].forEach(selector => $(selector).addEventListener('click', () => changeTrack(-1)));
  ['#seekBar', '#fullSeekBar'].forEach(selector => $(selector).addEventListener('input', event => {
    if (Number.isFinite(audio.duration)) audio.currentTime = audio.duration * Number(event.target.value) / 1000;
  }));
  ['#shuffleButton', '#fullShuffle'].forEach(selector => $(selector).addEventListener('click', () => { state.shuffle = !state.shuffle; renderAll(); showToast(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено'); }));
  $('#repeatButton').addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    renderAll();
    showToast(state.repeat === 'one' ? 'Повтор трека' : state.repeat === 'all' ? 'Повтор очереди' : 'Повтор выключен');
  });
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('loadedmetadata', () => {
    const track = currentTrack();
    if (track && Math.abs(track.duration - audio.duration) > 1) { track.duration = audio.duration; saveTrack(track); }
    updateProgress();
  });
  audio.addEventListener('play', () => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; renderAll(); });
  audio.addEventListener('pause', () => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; renderAll(); });
  audio.addEventListener('ended', async () => {
    if (state.repeat === 'one') { audio.currentTime = 0; await audio.play(); return; }
    if (!$('#autoplayToggle').checked) return;
    const id = nextId(1);
    if (id) await playTrack(id, false);
  });
  audio.addEventListener('error', () => currentTrack() && showToast('Не удалось воспроизвести этот формат'));

  $$('.bottom-nav button, [data-nav]').forEach(button => button.addEventListener('click', event => {
    const name = event.currentTarget.dataset.nav;
    if (name) navigate(name);
  }));
  $('#openSettings').addEventListener('click', () => navigate('settings'));
  $('#miniOpen').addEventListener('click', openFullPlayer);
  $('#coverArt').addEventListener('click', openFullPlayer);
  $('#nowTitle').addEventListener('click', openFullPlayer);
  ['#searchButton', '#floatingSearch'].forEach(selector => $(selector).addEventListener('click', () => { navigate('library'); setTimeout(() => $('#searchInput').focus(), 250); }));
  $('#searchInput').addEventListener('input', event => { state.search = event.target.value; renderTrackLists(); });
  $('#clearSearch').addEventListener('click', () => { $('#searchInput').value = ''; state.search = ''; renderTrackLists(); });
  $$('.segmented button').forEach(button => button.addEventListener('click', () => {
    applyFilter(button.dataset.filter);
  }));
  $('#sortButton').addEventListener('click', event => {
    state.sort = state.sort === 'recent' ? 'title' : 'recent';
    event.currentTarget.textContent = state.sort === 'recent' ? 'ПО ДАТЕ ↓' : 'ПО НАЗВАНИЮ ↑';
    renderTrackLists();
  });
  ['#recentTracks', '#libraryTracks', '#queueTracks'].forEach(selector => $(selector).addEventListener('click', event => {
    const menu = event.target.closest('[data-menu]');
    if (menu) { event.stopPropagation(); openTrackMenu(menu.dataset.menu); return; }
    const row = event.target.closest('.track-row');
    if (row) playTrack(row.dataset.id, !selector.includes('queue'));
  }));
  $('#favoriteTracks').addEventListener('click', event => {
    const track = event.target.closest('[data-circle-id]');
    if (track) playTrack(track.dataset.circleId);
    else if (event.target.closest('[data-favorites-empty]')) applyFilter('all');
  });
  $$('[data-favorites-open]').forEach(button => button.addEventListener('click', () => applyFilter('favorites')));
  $$('[data-smart]').forEach(button => button.addEventListener('click', () => applyFilter(button.dataset.smart === 'recent' ? 'all' : button.dataset.smart)));
  $('#trackMenu').addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action) handleTrackAction(action);
  });
  $('#trackMenu').addEventListener('click', event => { if (event.target === $('#trackMenu')) $('#trackMenu').close(); });
  $('#clearQueue').addEventListener('click', () => {
    if (!state.queue.length || confirm('Очистить очередь?')) { state.queue = []; renderAll(); }
  });
  $('#accentPicker').addEventListener('click', event => {
    const name = event.target.closest('[data-accent]')?.dataset.accent;
    if (name) setAccent(name);
  });
  $('#sleepTimer').addEventListener('click', () => $('#timerMenu').showModal());
  $('#closeFullPlayer').addEventListener('click', closeFullPlayer);
  $('#fullPlayer').addEventListener('close', renderPlayer);
  $('#fullFavorite').addEventListener('click', async () => {
    const track = currentTrack();
    if (!track) return;
    track.favorite = !track.favorite;
    await saveTrack(track);
    renderAll();
    showToast(track.favorite ? 'Добавлено в любимые' : 'Убрано из любимых');
  });
  $('#fullQueue').addEventListener('click', () => { closeFullPlayer(); navigate('queue'); });
  $('#fullSleep').addEventListener('click', () => { closeFullPlayer(); setTimeout(() => $('#timerMenu').showModal(), 120); });
  $('#fullMore').addEventListener('click', () => {
    const track = currentTrack();
    if (!track) return;
    closeFullPlayer();
    setTimeout(() => openTrackMenu(track.id), 120);
  });
  $('#volumeToggle').addEventListener('click', () => $('#volumePanel').classList.toggle('open'));
  $('#volumeRange').addEventListener('input', event => {
    audio.volume = Number(event.target.value) / 100;
    $('#volumeValue').textContent = `${event.target.value}%`;
    localStorage.setItem('aura-volume', event.target.value);
  });
  $('#speedButton').addEventListener('click', event => {
    const speeds = [1, 1.25, 1.5, 2];
    audio.playbackRate = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length];
    event.currentTarget.textContent = `${audio.playbackRate}×`;
    updateProgress();
  });
  $('#timerMenu').addEventListener('click', event => {
    const minutes = event.target.closest('[data-minutes]')?.dataset.minutes;
    if (minutes !== undefined) setSleepTimer(Number(minutes));
    else if (event.target === $('#timerMenu')) $('#timerMenu').close();
  });
  $('#deleteAll').addEventListener('click', async () => {
    if (!state.tracks.length) return showToast('Музыки пока нет');
    if (!confirm('Удалить все треки с этого устройства? Отменить это действие нельзя.')) return;
    audio.pause();
    await clearTracks();
    state.coverUrls.forEach(url => URL.revokeObjectURL(url));
    state.coverUrls.clear();
    state.tracks = [];
    state.queue = [];
    state.currentId = null;
    audio.removeAttribute('src');
    localStorage.removeItem('aura-current');
    renderAll();
    showToast('Вся музыка удалена');
  });
}

function setupMediaActions() {
  if (!('mediaSession' in navigator)) return;
  const actions = {
    play: () => audio.play(), pause: () => audio.pause(), previoustrack: () => changeTrack(-1), nexttrack: () => changeTrack(1),
    seekbackward: details => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10)); },
    seekforward: details => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (details.seekOffset || 10)); },
    seekto: details => { if (details.seekTime != null) audio.currentTime = details.seekTime; }
  };
  for (const [action, handler] of Object.entries(actions)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* not supported by this Safari version */ }
  }
}

async function init() {
  setupWaveform();
  bindEvents();
  setupMediaActions();
  setAccent(localStorage.getItem('aura-accent') || 'violet');
  const savedVolume = Math.min(100, Math.max(0, Number(localStorage.getItem('aura-volume') ?? 100)));
  audio.volume = savedVolume / 100;
  $('#volumeRange').value = savedVolume;
  $('#volumeValue').textContent = `${savedVolume}%`;
  $('#greeting').textContent = new Date().getHours() < 6 ? 'ДОБРОЙ НОЧИ' : new Date().getHours() < 12 ? 'ДОБРОЕ УТРО' : new Date().getHours() < 18 ? 'ДОБРЫЙ ДЕНЬ' : 'ДОБРЫЙ ВЕЧЕР';
  try {
    db = await openDatabase();
    state.tracks = (await getAllTracks()).sort((a, b) => b.added - a.added);
    state.queue = state.queue.filter(id => state.tracks.some(track => track.id === id));
    if (!state.queue.length) state.queue = state.tracks.map(track => track.id);
    if (!state.tracks.some(track => track.id === state.currentId)) state.currentId = state.tracks[0]?.id || null;
    renderAll();
    if (state.currentId) await loadCurrent(false);
  } catch (error) {
    console.error(error);
    showToast('Не удалось открыть локальное хранилище');
  }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(console.warn);
}

init();
