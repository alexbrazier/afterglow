/* global Tone */
// ?v= is replaced with the commit on deploy so phones don't keep stale modules
import { Engine, CHANNELS } from './engine.js?v=__BUILD__';
import { Composer, journeyCurve } from './composer.js?v=__BUILD__';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const seedParam = Number.parseInt(params.get('seed'), 10);
const engine = new Engine();
const composer = new Composer(Number.isFinite(seedParam) ? seedParam >>> 0 : undefined);
window.afterglow = { engine, composer }; // handy for poking at it from the console

const LOOKAHEAD = 1.2; // seconds of audio scheduled ahead of the playhead
let state = 'idle'; // idle | loading | playing | paused
let nextBarTime = 0;
let gen = 0; // bumps on every seek so stale UI callbacks for discarded bars are ignored
let tempoNudge = 0;
let volume = 0.85;
let current = null; // the bar being heard: { bar, t, dur }
let playedSeconds = 0;
let recorder = null;

// ---------- settings persistence ----------

const SETTINGS_KEY = 'afterglow.settings';
const settingInputs = () => [...document.querySelectorAll('.controls input[type=range]')];
const settingId = (el) => el.id || `mix-${el.dataset.mix}`;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const el of settingInputs()) if (settingId(el) in saved) el.value = saved[settingId(el)];
    return saved;
  } catch { return {}; }
}

function saveSettings() {
  try {
    const out = Object.fromEntries(settingInputs().map((el) => [settingId(el), el.value]));
    out.showInstruments = !$('instruments').hidden;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
  } catch { /* storage unavailable — settings just won't persist */ }
}

// ---------- status line ----------

let statusTimer = 0;
const defaultStatus = () => ({
  idle: 'Samples load on first play (~4 MB).',
  loading: 'Loading…',
  playing: 'Playing — it never ends, so settle in.',
  paused: 'Paused.',
}[state]);

function setStatus(msg, ttl = 0) {
  clearTimeout(statusTimer);
  $('status').textContent = msg ?? defaultStatus();
  if (ttl) statusTimer = setTimeout(() => { $('status').textContent = defaultStatus(); }, ttl);
}

// ---------- scheduling ----------

function tick() {
  if (state !== 'playing') return;
  const now = engine.now();
  if (nextBarTime < now) nextBarTime = now + 0.1;
  while (nextBarTime < now + LOOKAHEAD) nextBarTime += scheduleBar(nextBarTime);
}

function scheduleBar(t) {
  const bar = composer.nextBar();
  const spb = 60 / (bar.bpm + tempoNudge);
  const dur = 4 * spb;
  if (bar.cut) engine.releaseAll(t, bar.cutFade);
  engine.setIntensity(bar.intensity, t, dur);
  for (const e of bar.events) {
    const jitter = e.type === 'one' ? (Math.random() - 0.5) * 0.014 : 0;
    const et = Math.max(t, t + e.beat * spb + jitter);
    if (e.type === 'sus') engine.sustain(e.ch, e.midi, et, e.dur * spb, e.vel, e.attack, e.release);
    else engine.oneshot(e.ch, e.midi, et, e.vel, e.maxDur);
  }
  const g = gen;
  Tone.Draw.schedule(() => {
    if (g !== gen) return;
    current = { bar, t, dur };
    playedSeconds += dur;
    renderNow(bar);
  }, t);
  return dur;
}

// ---------- seeking ----------

// Throw away what is scheduled and restart from wherever the composer now points.
function restartScheduling(label) {
  gen++;
  if (state === 'playing') {
    const now = engine.now();
    engine.releaseAll(now, 0.35);
    nextBarTime = now + 0.12;
    tick();
  } else if (current) {
    // paused: show where playback will resume from
    const j = composer.journey;
    const sec = j.sections[composer.secIdx];
    current = {
      bar: { ...current.bar, journey: j, secIdx: composer.secIdx, bar: composer.barInSec, section: sec.name, bars: sec.bars, chord: sec.chords[composer.barInSec].name },
      t: engine.now(), dur: Infinity,
    };
    renderNow(current.bar);
  }
  if (label) setStatus(label, 2500);
}

function jump(journey, secIdx, bar = 0) {
  composer.seek(journey, secIdx, bar);
  restartScheduling(`→ ${journey.sections[secIdx].name}${bar ? `, bar ${bar + 1}` : ''}`);
}

function nextSection() {
  if (!current) return;
  const { journey, secIdx } = current.bar;
  if (secIdx + 1 < journey.sections.length) jump(journey, secIdx + 1);
  else nextJourney();
}

function prevSection() {
  if (!current) return;
  const { journey, secIdx, bar } = current.bar;
  if (bar >= 2) return jump(journey, secIdx);
  if (secIdx > 0) return jump(journey, secIdx - 1);
  const i = composer.history.indexOf(journey);
  if (i > 0) {
    const prev = composer.history[i - 1];
    return jump(prev, prev.sections.length - 1);
  }
  jump(journey, 0);
}

function nextJourney() {
  if (!current) return;
  composer.seekNextJourney(current.bar.journey);
  restartScheduling(`→ Journey ${composer.journey.no}`);
}

function prevJourney() {
  if (!current) return;
  const { journey, secIdx, bar } = current.bar;
  const i = composer.history.indexOf(journey);
  if ((secIdx > 0 || bar >= 2 || i <= 0)) jump(journey, 0);
  else jump(composer.history[i - 1], 0);
}

// ---------- iOS silent switch ----------

// iOS plays Web Audio in the "ambient" audio session, which the ring/silent switch mutes.
// Two things move it to the "playback" session a music app uses:
//  - navigator.audioSession.type = 'playback' (Safari 17+), set before any audio starts;
//  - a near-silent looping <audio> element, started inside the Play tap (older iOS).
// An AudioContext keeps the session it was running in, so once the element is playing the
// context is suspended and resumed to re-attach it to the playback session (as unmute.js does).
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
let keepAlive = null;
let keepAliveError = null;
let contextCycled = false;

function setSessionType() {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
  } catch { /* unsupported: the keep-alive element covers it */ }
}
setSessionType();

// Half a second of 8 kHz audio at ±1 LSB (about -90 dB): inaudible, but not digital silence.
function silentWavUrl() {
  const rate = 8000;
  const n = rate / 2;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

async function cycleContext() {
  const raw = Tone.getContext().rawContext;
  if (raw.state !== 'running') return;
  try {
    await raw.suspend();
    await raw.resume();
    contextCycled = true;
  } catch (e) {
    console.warn('could not restart audio context', e);
  }
}

// Must be called synchronously inside the Play tap.
function usePlaybackSession() {
  setSessionType();
  if (!isIOS) return;
  if (!keepAlive) {
    keepAlive = document.createElement('audio');
    keepAlive.src = silentWavUrl();
    keepAlive.loop = true;
    keepAlive.preload = 'auto';
    keepAlive.setAttribute('playsinline', '');
    keepAlive.setAttribute('x-webkit-airplay', 'deny');
    keepAlive.addEventListener('playing', () => { if (state === 'playing') cycleContext(); });
  }
  keepAlive.play().then(() => { keepAliveError = null; }, (e) => { keepAliveError = e.name; });
}

// ---------- transport ----------

async function play() {
  if (state === 'loading') return;
  usePlaybackSession();
  if (state === 'idle') {
    state = 'loading';
    $('loading').classList.add('show');
    try {
      await engine.init((p) => {
        $('loadpct').textContent = `${Math.round(p * 100)}%`;
        $('loadbar').style.width = `${p * 100}%`;
      });
    } catch (e) {
      console.error(e);
      state = 'idle';
      $('loading').classList.remove('show');
      setStatus(`Could not start audio: ${e.message}`);
      return;
    }
    $('loading').classList.remove('show');
    engine.setReverb(+$('reverb').value);
    document.querySelectorAll('[data-mix]').forEach((el) => engine.setMix(el.dataset.mix, +el.value));
    Tone.getContext().on('tick', tick);
    setInterval(tick, 100); // belt and braces if the context ticker is throttled
    buildLanes();
  } else {
    composer.resync();
  }
  await Tone.start();
  engine.setVolume(volume, 1.2);
  nextBarTime = engine.now() + 0.15;
  gen++;
  state = 'playing';
  $('play').textContent = 'Pause';
  for (const id of ['prevSec', 'nextSec', 'rec', 'prevJourney', 'nextJourney']) $(id).disabled = false;
  setStatus();
  setMediaState();
  tick();
  if (keepAlive && !keepAlive.paused && keepAlive.currentTime > 0) cycleContext();
}

function pause() {
  state = 'paused';
  const now = engine.now();
  engine.releaseAll(now, 0.8);
  engine.setVolume(0, 1.5);
  keepAlive?.pause();
  $('play').textContent = 'Play';
  setStatus();
  setMediaState();
  if (recorder) toggleRecord();
}

const togglePlay = () => (state === 'playing' ? pause() : play());
$('play').addEventListener('click', togglePlay);
$('nextSec').addEventListener('click', nextSection);
$('prevSec').addEventListener('click', prevSection);
$('nextJourney').addEventListener('click', nextJourney);
$('prevJourney').addEventListener('click', prevJourney);

async function toggleRecord() {
  const btn = $('rec');
  if (!recorder) {
    if (state !== 'playing') return;
    recorder = engine.recorder;
    recorder.start();
    btn.classList.add('on');
    btn.textContent = 'Stop recording';
    return;
  }
  const blob = await recorder.stop();
  recorder = null;
  btn.classList.remove('on');
  btn.textContent = 'Record';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `afterglow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
  a.click();
  setStatus('Recording saved to your downloads.', 4000);
}
$('rec').addEventListener('click', toggleRecord);

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea')) return;
  if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); nextSection(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); prevSection(); }
  else if (e.key === 'i' || e.key === 'I') toggleInstruments();
});

// Media keys / OS now-playing controls, where the browser supports them.
function setMediaState() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = state === 'playing' ? 'playing' : 'paused';
}
if ('mediaSession' in navigator) {
  const handlers = { play, pause, nexttrack: nextSection, previoustrack: prevSection };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

// ---------- controls ----------

function applyControl(el) {
  const v = +el.value;
  if (el.dataset.mix) { if (state !== 'idle') engine.setMix(el.dataset.mix, v); return; }
  switch (el.id) {
    case 'energy':
      composer.energy = v;
      $('energyv').textContent = (v > 0 ? '+' : '') + v.toFixed(2);
      break;
    case 'tempoNudge':
      tempoNudge = v;
      $('tempov').textContent = (v > 0 ? '+' : '') + v;
      break;
    case 'volume':
      volume = v;
      if (state === 'playing') engine.setVolume(volume, 0.1);
      break;
    case 'reverb':
      if (state !== 'idle') engine.setReverb(v);
      break;
  }
}
const saved = loadSettings();
for (const el of settingInputs()) {
  applyControl(el);
  el.addEventListener('input', () => { applyControl(el); saveSettings(); });
}

// Each panel's Reset puts its sliders back to the defaults written in the HTML.
for (const btn of document.querySelectorAll('[data-reset]')) {
  btn.addEventListener('click', () => {
    for (const el of btn.closest('.panel').querySelectorAll('input[type=range]')) {
      el.value = el.defaultValue;
      applyControl(el);
    }
    saveSettings();
  });
}

$('seed').textContent = composer.seed;
const build = document.querySelector('meta[name=build]')?.content ?? '';
$('build').textContent = build.startsWith('__') ? 'dev' : build;

// ?debug shows what the audio stack is doing (useful for phone-only problems).
if (params.has('debug')) {
  const pre = document.createElement('pre');
  pre.className = 'debug';
  document.querySelector('footer').after(pre);
  setInterval(() => {
    const raw = Tone.getContext().rawContext;
    pre.textContent = [
      `build ${$('build').textContent}  ios ${isIOS}  ua ${navigator.userAgent}`,
      `audioSession ${navigator.audioSession ? `${navigator.audioSession.type} / ${navigator.audioSession.state}` : 'unsupported'}`,
      `context ${raw.state} @ ${raw.sampleRate} Hz  restarted ${contextCycled}`,
      `keepAlive ${keepAlive ? `paused ${keepAlive.paused}  t ${keepAlive.currentTime.toFixed(1)}  ready ${keepAlive.readyState}  error ${keepAliveError ?? keepAlive.error?.code ?? 'none'}` : 'not created'}`,
      `voices ${engine.voices.size}  state ${state}`,
    ].join('\n');
  }, 500);
}
$('copySeed').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?seed=${composer.seed}`;
  try {
    await navigator.clipboard.writeText(url);
    setStatus('Link copied — it starts this same performance.', 3000);
  } catch {
    setStatus(url, 8000);
  }
});

// ---------- now playing ----------

function renderNow(bar) {
  $('section').textContent = bar.section;
  $('chord').textContent = bar.chord;
  $('next').textContent = bar.nextChord ? `next: ${bar.nextChord}` : '';
  $('key').textContent = bar.key;
  $('tempo').textContent = `${bar.bpm + tempoNudge} bpm`;
  $('barpos').textContent = `bar ${bar.bar + 1} / ${bar.bars}`;
  $('intensity').style.width = `${Math.round(bar.intensity * 100)}%`;
  $('journey').textContent = `Journey ${bar.journey.no}`;
  const s = Math.floor(playedSeconds);
  $('elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} played`;
  $('prevJourney').disabled = composer.history.indexOf(bar.journey) <= 0 && bar.secIdx === 0 && bar.bar < 2;
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: bar.section, artist: 'Afterglow', album: `Journey ${bar.journey.no} · ${bar.key}` });
  }
}

// ---------- timeline ----------

const COLORS = {
  dawn: '#5b7bb5', stirring: '#6f86c9', reflect: '#6f86c9', rising: '#a99ad6',
  anthem: '#f2b45a', fall: '#4f5d80', resolve: '#c9a36b',
};
const tl = $('timeline');
let drag = null; // x while dragging
let hover = null; // x while hovering

function positionAt(x) {
  const { journey } = current.bar;
  const total = journey.sections.reduce((a, s) => a + s.bars, 0);
  let b = Math.max(0, Math.min(total - 1, Math.floor((x / tl.clientWidth) * total)));
  for (let i = 0; i < journey.sections.length; i++) {
    if (b < journey.sections[i].bars) return { journey, secIdx: i, bar: b };
    b -= journey.sections[i].bars;
  }
  return { journey, secIdx: 0, bar: 0 };
}

tl.addEventListener('pointerdown', (e) => {
  if (!current) return;
  tl.setPointerCapture(e.pointerId);
  drag = e.offsetX;
});
tl.addEventListener('pointermove', (e) => {
  hover = e.offsetX;
  if (drag !== null) drag = Math.max(0, Math.min(tl.clientWidth - 1, e.offsetX));
});
tl.addEventListener('pointerup', () => {
  if (drag === null) return;
  const pos = positionAt(drag);
  drag = null;
  jump(pos.journey, pos.secIdx, pos.bar);
});
tl.addEventListener('pointercancel', () => { drag = null; });
tl.addEventListener('pointerleave', () => { hover = null; });

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const w = tl.clientWidth;
  const h = tl.clientHeight;
  if (tl.width !== w * dpr) { tl.width = w * dpr; tl.height = h * dpr; }
  const g = tl.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!current) {
    g.fillStyle = '#8f93a3';
    g.font = '13px Inter, sans-serif';
    g.fillText('The journey map appears once the music starts.', 0, h / 2);
    return;
  }
  const { journey, secIdx, bar } = current.bar;
  const total = journey.sections.reduce((a, s) => a + s.bars, 0);
  const top = 8;
  const bottom = h - 24;
  const x = (b) => (b / total) * w;
  const y = (i) => bottom - i * (bottom - top);

  const curve = journeyCurve(journey, composer.energy);
  let acc = 0;
  g.font = '11px Inter, sans-serif';
  g.textBaseline = 'top';
  journey.sections.forEach((s, i) => {
    const x0 = x(acc);
    const x1 = x(acc + s.bars);
    g.fillStyle = i === secIdx ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)';
    g.fillRect(x0 + 1, top, x1 - x0 - 2, bottom - top);
    g.fillStyle = COLORS[s.id];
    g.fillRect(x0 + 1, bottom + 4, x1 - x0 - 2, 3);
    if (x1 - x0 > 60) {
      g.fillStyle = i === secIdx ? '#e9e6df' : '#8f93a3';
      g.fillText(s.name, x0 + 4, bottom + 10);
    }
    // the bar-by-bar intensity, joined to the previous section's last bar so the glide shows
    g.strokeStyle = COLORS[s.id];
    g.lineWidth = 2;
    g.beginPath();
    if (acc > 0 && !s.cut) g.moveTo(x(acc - 0.5), y(curve[acc - 1]));
    for (let k = 0; k < s.bars; k++) {
      const px = x(acc + k + 0.5);
      if (k === 0 && (acc === 0 || s.cut)) g.moveTo(px, y(curve[acc + k])); else g.lineTo(px, y(curve[acc + k]));
    }
    g.stroke();
    acc += s.bars;
  });

  // playhead, interpolated within the current bar
  const before = journey.sections.slice(0, secIdx).reduce((a, s) => a + s.bars, 0);
  const frac = Number.isFinite(current.dur) ? Math.min(1, Math.max(0, (engine.now() - current.t) / current.dur)) : 0;
  const px = drag ?? x(before + bar + frac);
  g.strokeStyle = '#e9e6df';
  g.lineWidth = drag !== null ? 2 : 1;
  g.beginPath();
  g.moveTo(px, top);
  g.lineTo(px, bottom);
  g.stroke();

  // where a click / drop would land
  const probe = drag ?? hover;
  if (probe !== null) {
    const pos = positionAt(probe);
    const label = `${journey.sections[pos.secIdx].name} · bar ${pos.bar + 1}`;
    g.font = '12px Inter, sans-serif';
    const tw = g.measureText(label).width + 12;
    const lx = Math.min(Math.max(0, probe - tw / 2), w - tw);
    if (drag === null) {
      g.strokeStyle = 'rgba(233,230,223,0.35)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(probe, top);
      g.lineTo(probe, bottom);
      g.stroke();
      g.setLineDash([]);
    }
    g.fillStyle = 'rgba(5,7,13,0.85)';
    g.fillRect(lx, top, tw, 20);
    g.fillStyle = '#e9e6df';
    g.textBaseline = 'middle';
    g.fillText(label, lx + 6, top + 10);
  }
}

// ---------- instruments view ----------

const LANES = [
  ['horns', 'French horns'], ['brass', 'Brass'], ['timp', 'Timpani'],
  ['harp', 'Harp'], ['celesta', 'Celesta'],
  ['choir', 'Choir · aah'], ['oohs', 'Choir · ooh'],
  ['melodyStr', 'Violins · melody'], ['trem', 'Tremolo strings'], ['pad', 'String pads'],
  ['pizz', 'Pizzicato'], ['cello', 'Cellos'], ['bass', 'Double basses'],
];
const GROUP_COLORS = { strings: '#7fb4ff', choir: '#c9a7ff', brass: '#f2b45a', texture: '#7fd6c2', perc: '#ff8a6b' };
const HISTORY = 160; // level samples kept per lane (~8 s)
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
const lanes = [];

function buildLanes() {
  const root = $('lanes');
  root.textContent = '';
  for (const [ch, label] of LANES) {
    const color = GROUP_COLORS[CHANNELS[ch].group];
    const row = document.createElement('div');
    row.className = 'lane';
    row.innerHTML = `
      <div class="lane-name"><i style="background:${color}"></i>${label}</div>
      <canvas aria-hidden="true"></canvas>
      <div class="lane-notes"></div>
      <div class="lane-btns">
        <button class="m" aria-pressed="false" title="Mute ${label}">M</button>
        <button class="s" aria-pressed="false" title="Solo ${label}">S</button>
      </div>`;
    root.append(row);
    const lane = { ch, color, row, canvas: row.querySelector('canvas'), notes: row.querySelector('.lane-notes'), levels: new Float32Array(HISTORY), head: 0 };
    const [mBtn, sBtn] = row.querySelectorAll('button');
    mBtn.addEventListener('click', () => {
      const on = mBtn.getAttribute('aria-pressed') !== 'true';
      mBtn.setAttribute('aria-pressed', on);
      engine.setMute(ch, on);
    });
    sBtn.addEventListener('click', () => {
      const on = sBtn.getAttribute('aria-pressed') !== 'true';
      sBtn.setAttribute('aria-pressed', on);
      engine.setSolo(ch, on);
    });
    lanes.push(lane);
  }
}

$('clearMutes').addEventListener('click', () => {
  for (const lane of lanes) {
    for (const b of lane.row.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
    engine.setMute(lane.ch, false);
    engine.setSolo(lane.ch, false);
  }
});

function toggleInstruments(force) {
  const show = force ?? $('instruments').hidden;
  $('instruments').hidden = !show;
  $('showInst').setAttribute('aria-pressed', show);
  saveSettings();
}
$('showInst').addEventListener('click', () => toggleInstruments());
if (saved.showInstruments) toggleInstruments(true);

let laneFrame = 0;
function drawLanes() {
  if ($('instruments').hidden || !lanes.length) return;
  const sample = laneFrame++ % 3 === 0; // ~20 level samples a second
  const active = engine.activeNotes();
  const anySolo = Object.values(engine.ch).some((c) => c.solo);
  const dpr = window.devicePixelRatio || 1;
  for (const lane of lanes) {
    const c = engine.ch[lane.ch];
    if (sample) {
      const db = 20 * Math.log10(Math.max(1e-5, engine.level(lane.ch)));
      lane.levels[lane.head] = Math.max(0, Math.min(1, (db + 54) / 48));
      lane.head = (lane.head + 1) % HISTORY;
    }
    const silent = c.muted || (anySolo && !c.solo);
    lane.row.classList.toggle('silent', silent);
    const notes = [...(active[lane.ch] ?? [])].sort((a, b) => a - b).map(noteName);
    lane.notes.textContent = notes.length > 4 ? `${notes.slice(0, 4).join(' ')} +${notes.length - 4}` : notes.join(' ');

    const cv = lane.canvas;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // mirrored level "waveform", newest on the right
    g.fillStyle = lane.color;
    g.globalAlpha = silent ? 0.25 : 0.85;
    const step = w / HISTORY;
    for (let i = 0; i < HISTORY; i++) {
      const v = lane.levels[(lane.head + i) % HISTORY];
      const bh = Math.max(1, v * (h - 2));
      g.fillRect(i * step, (h - bh) / 2, Math.max(1, step - 0.6), bh);
    }
    g.globalAlpha = 1;
  }
}

// ---------- backdrop ----------

const sky = $('sky');
const stars = Array.from({ length: 220 }, () => ({
  x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8, tw: Math.random() * Math.PI * 2,
}));
let glow = 0;
function frame(ts) {
  const dpr = window.devicePixelRatio || 1;
  const w = innerWidth;
  const h = innerHeight;
  if (sky.width !== w * dpr || sky.height !== h * dpr) { sky.width = w * dpr; sky.height = h * dpr; }
  const g = sky.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const target = state === 'playing' && current ? current.bar.intensity : 0.05;
  glow += (target - glow) * 0.01;
  g.fillStyle = '#05070d';
  g.fillRect(0, 0, w, h);
  const grad = g.createRadialGradient(w * 0.5, h * 1.05, 0, w * 0.5, h * 1.05, Math.max(w, h) * (0.6 + glow * 0.5));
  grad.addColorStop(0, `rgba(242,180,90,${0.08 + glow * 0.32})`);
  grad.addColorStop(0.45, `rgba(90,110,190,${0.05 + glow * 0.12})`);
  grad.addColorStop(1, 'rgba(5,7,13,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  for (const s of stars) {
    s.y -= 0.00003 * s.z * (1 + glow * 3);
    if (s.y < 0) s.y += 1;
    const a = (0.25 + 0.5 * s.z) * (0.7 + 0.3 * Math.sin(ts / 900 + s.tw));
    g.fillStyle = `rgba(233,230,223,${a})`;
    g.fillRect(s.x * w, s.y * h, s.z * 1.6, s.z * 1.6);
  }
  drawTimeline();
  drawLanes();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
