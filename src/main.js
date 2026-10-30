/* global Tone */
import { Engine } from './engine.js';
import { Composer, sectionIntensity } from './composer.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();
const composer = new Composer();
window.afterglow = { engine, composer }; // handy for poking at it from the console

const LOOKAHEAD = 1.2; // seconds of audio scheduled ahead of the playhead
let state = 'idle'; // idle | loading | playing | paused
let nextBarTime = 0;
let tempoNudge = 0;
let volume = 0.85;
let current = null; // { bar, t, dur }
let playedSeconds = 0;
let recorder = null;

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
  Tone.Draw.schedule(() => {
    current = { bar, t, dur };
    playedSeconds += dur;
    renderNow(bar);
  }, t);
  return dur;
}

// ---------- transport ----------

async function play() {
  if (state === 'loading') return;
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
      $('status').textContent = `Could not start audio: ${e.message}`;
      state = 'idle';
      $('loading').classList.remove('show');
      return;
    }
    $('loading').classList.remove('show');
    engine.setReverb(+$('reverb').value);
    document.querySelectorAll('[data-mix]').forEach((el) => engine.setMix(el.dataset.mix, +el.value));
    Tone.getContext().on('tick', tick);
    setInterval(tick, 100); // belt and braces if the context ticker is throttled
  } else {
    composer.resync();
  }
  await Tone.start();
  engine.setVolume(volume, 1.2);
  nextBarTime = engine.now() + 0.15;
  state = 'playing';
  $('play').textContent = 'Pause';
  $('skip').disabled = false;
  $('rec').disabled = false;
  $('status').textContent = 'Playing — it never ends, so settle in.';
  tick();
}

function pause() {
  state = 'paused';
  const now = engine.now();
  engine.releaseAll(now, 0.8);
  engine.setVolume(0, 1.5);
  $('play').textContent = 'Play';
  $('status').textContent = 'Paused.';
  if (recorder) toggleRecord();
}

$('play').addEventListener('click', () => (state === 'playing' ? pause() : play()));
$('skip').addEventListener('click', () => {
  composer.skipSection();
  $('status').textContent = 'Moving on at the next bar…';
});

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
  $('status').textContent = 'Recording saved to your downloads.';
}
$('rec').addEventListener('click', toggleRecord);

// ---------- controls ----------

$('energy').addEventListener('input', (e) => {
  composer.energy = +e.target.value;
  $('energyv').textContent = (composer.energy > 0 ? '+' : '') + composer.energy.toFixed(2);
});
$('tempoNudge').addEventListener('input', (e) => {
  tempoNudge = +e.target.value;
  $('tempov').textContent = (tempoNudge > 0 ? '+' : '') + tempoNudge;
});
$('volume').addEventListener('input', (e) => {
  volume = +e.target.value;
  if (state === 'playing') engine.setVolume(volume, 0.1);
});
$('reverb').addEventListener('input', (e) => state !== 'idle' && engine.setReverb(+e.target.value));
document.querySelectorAll('[data-mix]').forEach((el) =>
  el.addEventListener('input', () => state !== 'idle' && engine.setMix(el.dataset.mix, +el.value)));

// ---------- display ----------

function renderNow(bar) {
  $('section').textContent = bar.section;
  $('chord').textContent = bar.chord;
  $('next').textContent = `next: ${bar.nextChord}`;
  $('key').textContent = bar.key;
  $('tempo').textContent = `${bar.bpm + tempoNudge} bpm`;
  $('barpos').textContent = `bar ${bar.bar + 1} / ${bar.bars}`;
  $('intensity').style.width = `${Math.round(bar.intensity * 100)}%`;
  $('journey').textContent = `Journey ${bar.journey.no}`;
  const s = Math.floor(playedSeconds);
  $('elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} played`;
}

const COLORS = {
  dawn: '#5b7bb5', stirring: '#6f86c9', reflect: '#6f86c9', rising: '#a99ad6',
  anthem: '#f2b45a', fall: '#4f5d80', resolve: '#c9a36b',
};

function drawTimeline() {
  const cv = $('timeline');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext('2d');
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
    // intensity ramp for this section
    g.strokeStyle = COLORS[s.id];
    g.lineWidth = 2;
    g.beginPath();
    for (let k = 0; k <= s.bars; k++) {
      const p = s.bars > 1 ? Math.min(1, k / (s.bars - 1)) : 1;
      const iv = Math.max(0, Math.min(1, sectionIntensity(s, p) + composer.energy));
      const px = x(acc + k);
      if (k === 0) g.moveTo(px, y(iv)); else g.lineTo(px, y(iv));
    }
    g.stroke();
    acc += s.bars;
  });

  // playhead, interpolated within the current bar
  const before = journey.sections.slice(0, secIdx).reduce((a, s) => a + s.bars, 0);
  const frac = Math.min(1, Math.max(0, (engine.now() - current.t) / current.dur));
  const px = x(before + bar + frac);
  g.strokeStyle = '#e9e6df';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(px, top);
  g.lineTo(px, bottom);
  g.stroke();
}

// Starfield whose glow follows the music's intensity.
const sky = $('sky');
const stars = Array.from({ length: 220 }, () => ({
  x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8, tw: Math.random() * Math.PI * 2,
}));
let glow = 0;
function drawSky(ts) {
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
  requestAnimationFrame(drawSky);
}
requestAnimationFrame(drawSky);
