// Generative composer. Each "journey" follows the arc measured from the reference track:
//   Dawn      high open-fifth drone on vi with a shimmering eighth-note pulse
//   Stirring  minor-key colours over a vi pedal (vi, IV/vi, iii sus4/vi …), sparse cello/horn line
//   Rising    brightening towards iii / ii sus4 / V, timpani roll into…
//   Anthem    a looping progression (often the descending-bass I – V/3 – vi – IV) with a theme whose
//             top line climbs against the bass, building pass by pass to full orchestra and choir
//   Fall      sudden drop to a quiet IV
//   Resolve   plagal settle onto I that swells and fades away
// Journeys chain forever, with new seeds for every progression, theme, length and sometimes key.

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const ROMAN = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SHARP_KEYS = new Set([7, 2, 9, 4, 11]);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const place = (pc, lo) => lo + ((pc - lo) % 12 + 12) % 12; // lowest midi >= lo with pitch class pc
const pcOf = (m) => ((m % 12) + 12) % 12;

const noteNames = (K) => (SHARP_KEYS.has(K) ? SHARP_NAMES : FLAT_NAMES);
export const keyName = (K) => `${noteNames(K)[(K + 9) % 12]} minor`;

// Chord tokens: roman numeral in the major key, optional /3 or /5 inversion, :flags
// (m = borrowed minor third, sus2, sus4, add9, 7, open = no third) and @pedal bass degree.
export function realize(tok, K) {
  const [main, pedalRn] = tok.split('@');
  const [head, ...flagList] = main.split(':');
  const [rn, inv] = head.split('/');
  const f = new Set(flagList);
  const deg = ROMAN[rn.toLowerCase()];
  const step = (n) => (K + MAJOR[(deg + n) % 7]) % 12;
  const root = step(0);
  const fifth = step(4);
  const third = f.has('m') ? (root + 3) % 12 : step(2);
  const pcs = [root, fifth];
  const required = [root];
  let color = null;
  if (f.has('sus2') || (f.has('open') && f.has('add9'))) color = step(1);
  else if (f.has('sus4')) color = step(3);
  else if (!f.has('open')) color = third;
  if (color !== null) { pcs.push(color); required.push(color); }
  if (f.has('add9') && !f.has('open')) { pcs.push(step(1)); required.push(step(1)); }
  let seventh = null;
  if (f.has('7')) { seventh = step(6); pcs.push(seventh); required.push(seventh); }

  let bass = root;
  if (pedalRn) bass = (K + MAJOR[ROMAN[pedalRn.toLowerCase()]]) % 12;
  else if (inv === '3') bass = third;
  else if (inv === '5') bass = fifth;

  const N = noteNames(K);
  const minor = color === third && (third - root + 12) % 12 === 3;
  let q = '';
  if (f.has('open')) q = f.has('add9') ? 'sus2' : '5';
  else if (f.has('sus2')) q = 'sus2';
  else if (f.has('sus4')) q = 'sus4';
  else if ((fifth - root + 12) % 12 === 6) q = 'dim';
  else if (minor) q = 'm';
  if (seventh !== null) q = minor ? 'm7' : (seventh - root + 12) % 12 === 11 ? 'maj7' : '7';
  if (f.has('add9') && !f.has('open')) q += 'add9';
  const name = N[root] + q + (bass !== root ? '/' + N[bass] : '');
  return { tok, root, fifth, pcs: [...new Set(pcs)], required: [...new Set(required)], bass, name };
}

// Pick an n-note voicing of the chord within [lo, hi] that covers the required tones and moves
// as little as possible from the previous voicing for this role.
function voiceChord(ch, lo, hi, n, prev, rng) {
  const cands = [];
  for (let m = lo; m <= hi; m++) if (ch.pcs.includes(pcOf(m))) cands.push(m);
  const center = (lo + hi) / 2;
  const need = ch.required.slice(0, n);
  let best = null;
  let bestCost = Infinity;
  const chosen = [];
  const evaluate = () => {
    const pcs = new Set(chosen.map(pcOf));
    if (!need.every((p) => pcs.has(p))) return;
    let cost = 0;
    if (prev?.length) {
      for (let i = 0; i < chosen.length; i++) {
        const j = Math.round((i * (prev.length - 1)) / Math.max(1, chosen.length - 1));
        cost += Math.abs(chosen[i] - prev[j]);
      }
    }
    const mean = chosen.reduce((a, b) => a + b, 0) / chosen.length;
    cost += Math.abs(mean - center) * 0.6 + rng() * 0.8;
    if (cost < bestCost) { bestCost = cost; best = chosen.slice(); }
  };
  const walk = (start) => {
    if (chosen.length === n) { evaluate(); return; }
    for (let i = start; i < cands.length; i++) {
      const m = cands[i];
      const last = chosen[chosen.length - 1];
      if (last !== undefined && (m - last < 2 || m - last > 12)) continue;
      if (chosen.length && m - chosen[0] > 26) break;
      chosen.push(m);
      walk(i + 1);
      chosen.pop();
    }
  };
  walk(0);
  return best ?? cands.slice(0, n);
}

function scaleStep(m, steps, scale) {
  const dir = Math.sign(steps);
  let x = m;
  for (let k = 0; k < Math.abs(steps); k++) {
    do { x += dir; } while (!scale.includes(pcOf(x)));
  }
  return x;
}

const CELLS = {
  low: [[4], [4], [2, 2], [3, 1], [-2, 2]],
  mid: [[2, 2], [3, 1], [1, 1, 2], [2, 1, 1], [1.5, 0.5, 2], [4]],
  high: [[1, 1, 2], [2, 1, 1], [1, 1, 1, 1], [1.5, 0.5, 1, 1], [3, 1], [2, 2]],
  end: [[4], [2, -2], [3, -1]],
};

const STIRRING_MARKOV = {
  'vi': { 'iii:sus4@vi': 3, 'IV@vi': 3, 'vi:add9': 1, 'V@vi': 1, 'ii@vi': 1 },
  'vi:add9': { 'iii:sus4@vi': 3, 'IV@vi': 2, 'I@vi': 1 },
  'IV@vi': { 'iii:sus4@vi': 3, 'vi': 2, 'V@vi': 1 },
  'iii:sus4@vi': { 'vi': 3, 'vi:add9': 2, 'IV@vi': 2 },
  'V@vi': { 'vi': 2, 'IV@vi': 2, 'iii:sus4@vi': 1 },
  'ii@vi': { 'vi': 2, 'iii:sus4@vi': 2 },
  'I@vi': { 'IV@vi': 2, 'vi': 1 },
};
const RISING = [
  ['iii', 'ii:sus4', 'ii', 'iii'],
  ['IV', 'V', 'iii', 'vi'],
  ['ii', 'iii', 'IV', 'V:sus4'],
  ['vi', 'iii', 'IV', 'V:add9'],
  ['iii', 'vi', 'ii:7', 'V:sus4'],
];
const ANTHEMS = [
  [4, ['I', 'V/3', 'vi', 'IV']],
  [2, ['vi', 'IV', 'I', 'V']],
  [2, ['IV', 'I/3', 'V', 'vi']],
  [2, ['I', 'V/3', 'vi', 'iii/5', 'IV', 'I/3', 'ii', 'V:sus4']],
  [1, ['vi', 'V', 'IV', 'IV:add9']],
  [1, ['I', 'vi', 'IV', 'V:sus4']],
];
const REFLECT = [['vi', 'IV', 'I', 'V'], ['IV', 'I/3', 'ii', 'vi'], ['vi', 'iii', 'IV', 'I']];
const RESOLVE = [
  [['I:sus4', 1], ['I', 0]],
  [['IV:m', 2], ['I', 0]],
  [['I', 0]],
  [['ii:7', 1], ['I:sus4', 1], ['I', 0]],
];
const MODULATIONS = [0, 0, 7, 5, 2, 10, 3];

// Per-bar intensity may only move this far between bars (except at a deliberate drop), so
// section boundaries and energy-slider changes glide instead of jumping.
const MAX_RISE = 0.12;
const MAX_FALL = 0.16;

// Section intensity at progress p (0..1): a straight ramp between `int`, or `env` breakpoints.
export function sectionIntensity(sec, p) {
  const pts = sec.env ?? [[0, sec.int[0]], [1, sec.int[1]]];
  const q = sec.id === 'anthem' ? Math.pow(p, 1.25) : p;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (q <= x1) return lerp(y0, y1, x1 > x0 ? (q - x0) / (x1 - x0) : 1);
  }
  return pts[pts.length - 1][1];
}

// One bar's intensity: the section's target, moved from the previous bar by at most the slew limit.
function barIntensity(sec, b, energy, prevI, fresh = false) {
  const p = sec.bars > 1 ? b / (sec.bars - 1) : 1;
  const target = clamp(sectionIntensity(sec, p) + energy * (sec.id === 'dawn' ? 0.4 : 1), 0, 1);
  if ((b === 0 && sec.cut) || fresh || prevI === undefined) return target;
  return clamp(target, prevI - MAX_FALL, prevI + (sec.maxRise ?? MAX_RISE));
}

// Per-bar intensity across a whole journey played straight through (for drawing the timeline).
export function journeyCurve(journey, energy) {
  const out = [];
  let prev;
  for (const sec of journey.sections) {
    for (let b = 0; b < sec.bars; b++) out.push(prev = barIntensity(sec, b, energy, prev));
  }
  return out;
}

export const SECTION_NAMES = {
  dawn: 'Dawn', stirring: 'Stirring', reflect: 'Reflection', rising: 'Rising',
  anthem: 'Anthem', fall: 'Falling away', resolve: 'Homecoming',
};

export class Composer {
  constructor(seed = (Math.random() * 2 ** 32) >>> 0) {
    this.seed = seed;
    this.r = mulberry32(seed);
    this.K = 0; // C major / A minor, as measured
    this.energy = 0;
    this.journeyNo = 0;
    this.journey = null;
    this.history = []; // past journeys, so the timeline can go back to them
    this.secIdx = 0;
    this.barInSec = 0;
    this.prevVoicing = {};
  }

  pick(arr) { return arr[Math.floor(this.r() * arr.length)]; }
  wpick(entries) { // [[weight, value], …] or { value: weight }
    const list = Array.isArray(entries) ? entries : Object.entries(entries).map(([v, w]) => [w, v]);
    let x = this.r() * list.reduce((a, [w]) => a + w, 0);
    for (const [w, v] of list) if ((x -= w) <= 0) return v;
    return list[list.length - 1][1];
  }

  // ---------- form ----------

  _newJourney() {
    if (this.journeyNo > 0) this.K = (this.history[this.history.length - 1].K + this.pick(MODULATIONS)) % 12;
    this.journeyNo++;
    const bpm = 66 + Math.round(this.r() * 8);
    const sections = [];
    if (this.journeyNo === 1 || this.r() < 0.75) sections.push(this._dawn(), this._stirring());
    else sections.push(this._reflect());
    if (this.r() < 0.8) sections.push(this._rising());
    sections.push(this._anthem(false));
    if (this.r() < 0.3) sections.push(this._fall(2), this._anthem(true));
    sections.push(this._fall(), this._resolve());
    this.journey = { no: this.journeyNo, K: this.K, bpm, sections };
    this.history.push(this.journey);
    if (this.history.length > 50) this.history.shift();
    this.secIdx = 0;
    this.barInSec = 0;
  }

  // Continue into the next journey: one already in the history (after seeking back), or a new one.
  _advanceJourney() {
    const i = this.history.indexOf(this.journey);
    if (i >= 0 && i < this.history.length - 1) {
      this.journey = this.history[i + 1];
      this.secIdx = 0;
      this.barInSec = 0;
    } else {
      this._newJourney();
    }
  }

  _section(id, list, int, extra = {}) {
    const chords = [];
    const starts = [];
    const lens = [];
    for (const [tok, n] of list) {
      const c = realize(tok, this.K);
      for (let i = 0; i < n; i++) {
        chords.push(c);
        starts.push(i === 0);
        lens.push(i === 0 ? n : 0);
      }
    }
    return {
      id, name: SECTION_NAMES[id], bars: chords.length, chords, starts, lens, int,
      melody: [], harpPat: this.pick(['up', 'updown', 'rock', 'wide']), ...extra,
    };
  }

  _dawn() {
    const bars = this.pick([4, 6, 8]);
    const list = bars >= 6 && this.r() < 0.6
      ? [['vi:open', bars / 2], ['vi:open:add9', bars / 2]]
      : [['vi:open', bars]];
    return this._section('dawn', list, [0.05, 0.16], { harpPat: 'pulse' });
  }

  _stirring() {
    const target = this.pick([12, 16, 16, 20]);
    const list = [['vi', 4]];
    let tok = 'vi';
    let total = 4;
    while (total < target) {
      tok = this.wpick(STIRRING_MARKOV[tok]);
      const released = total > target / 2 && this.r() < 0.5 ? tok.replace('@vi', '') : tok;
      const n = Math.min(2, target - total);
      list.push([released, n]);
      total += n;
    }
    list[list.length - 1][0] = this.pick(['iii:sus4', 'IV', 'IV@vi']);
    const sec = this._section('stirring', list, [0.18, 0.45]);
    sec.melody = this._line(sec, { lo: 50, hi: 64, density: 0.15, shape: 'arch', sparse: 0.45 });
    return sec;
  }

  _reflect() {
    const prog = this.pick(REFLECT);
    const list = [...prog, ...prog].map((t) => [t, 2]);
    const sec = this._section('reflect', list, [0.12, 0.32], { harpPat: 'updown' });
    sec.melody = this._line(sec, { lo: 50, hi: 66, density: 0.25, shape: 'arch', sparse: 0.2 });
    return sec;
  }

  _rising() {
    const list = this.pick(RISING).map((t) => [t, 2]);
    if (this.r() < 0.4) list.push(...this.pick(RISING).map((t) => [t, 1]));
    list.pop();
    if (this.r() < 0.6) list.push(['V:sus4', 1], ['V', 1]);
    else list.push(['IV', 2]);
    const sec = this._section('rising', list, [0.45, 0.64]);
    sec.melody = this._line(sec, { lo: 62, hi: 79, density: 0.45, shape: 'rise' });
    return sec;
  }

  _anthem(short) {
    const prog = this.wpick(ANTHEMS);
    const per = prog.length <= 4 ? 2 : 1;
    const loopLen = prog.length * per;
    const passes = short ? 1 : this.pick([2, 3, 3, 4]);
    const list = [];
    for (let p = 0; p < passes; p++) {
      for (const tok of prog) {
        const color = p > 0 && tok === 'I' && this.r() < 0.3 ? 'I:add9' : tok;
        list.push([color, per]);
      }
    }
    const sec = this._section('anthem', list, short ? [0.86, 1.0] : [0.6, 1.0], { loopLen, passes });
    // One theme per anthem, restated every pass so it becomes recognisable.
    const loop = { ...sec, bars: loopLen, chords: sec.chords.slice(0, loopLen), starts: sec.starts.slice(0, loopLen) };
    const theme = this._line(loop, { lo: 64, hi: 81, density: 0.5, shape: 'climb' });
    for (let p = 0; p < passes; p++) {
      for (const e of theme) sec.melody.push({ ...e, bar: e.bar + p * loopLen });
    }
    return sec;
  }

  _fall(bars = this.pick([2, 3, 4])) {
    return this._section('fall', [[this.pick(['IV', 'IV:add9']), bars]], [0.3, 0.22], { cut: true });
  }

  _resolve() {
    const bars = this.pick([6, 8, 8, 10]);
    const tmpl = this.pick(RESOLVE);
    const fixed = tmpl.reduce((a, [, n]) => a + n, 0);
    const list = tmpl.map(([t, n]) => [t, n || bars - fixed]);
    // Swell out of the quiet fall up to the arrival of the home chord, then fade away.
    const peakBar = Math.max(2, fixed);
    const peak = peakBar / (bars - 1);
    const sec = this._section('resolve', list, [0.3, 0.0], {
      harpPat: 'updown', peakBar, maxRise: 0.23, env: [[0, 0.3], [peak, 0.74], [1, 0.0]],
    });
    const head = { ...sec, bars: 3 };
    sec.melody = this._line(head, { lo: 67, hi: 84, density: 0.2, shape: 'fall' });
    return sec;
  }

  // ---------- melody ----------

  _line(sec, { lo, hi, density, shape, sparse = 0 }) {
    const scale = MAJOR.map((x) => (this.K + x) % 12);
    const events = [];
    let prev = Math.round(lo + (hi - lo) * (shape === 'fall' ? 0.75 : 0.35));
    for (let b = 0; b < sec.bars; b++) {
      const ch = sec.chords[b];
      const phrasePos = b % 4;
      const held = !sec.starts[b];
      if (sparse && this.r() < sparse) continue;
      let kind = density < 0.3 ? 'low' : density < 0.6 ? 'mid' : 'high';
      if (phrasePos === 3 || (held && this.r() < 0.55)) kind = this.r() < 0.7 ? 'end' : 'low';
      const cell = this.pick(CELLS[kind]);
      let dir;
      if (shape === 'rise') dir = 1;
      else if (shape === 'fall') dir = -1;
      else if (shape === 'climb') dir = b < sec.bars * 0.75 ? 1 : -1;
      else dir = phrasePos < 2 ? 1 : -1;
      let beat = 0;
      cell.forEach((len, i) => {
        if (len < 0) { beat += -len; return; }
        let m;
        if (i === 0 || beat === 2) {
          const goal = prev + dir * (1 + this.r() * 3);
          let bestCost = Infinity;
          for (let x = lo; x <= hi; x++) {
            if (!ch.pcs.includes(pcOf(x))) continue;
            const cost = Math.abs(x - goal) + (Math.abs(x - prev) > 7 ? 4 : 0) + this.r() * 0.5;
            if (cost < bestCost) { bestCost = cost; m = x; }
          }
          m ??= prev;
        } else {
          const away = this.r() < 0.2 ? -1 : 1;
          m = scaleStep(prev, dir * away * (this.r() < 0.75 ? 1 : 2), scale);
        }
        if (m > hi) m = scaleStep(hi, -1 - Math.floor(this.r() * 2), scale);
        if (m < lo) m = scaleStep(lo, 1 + Math.floor(this.r() * 2), scale);
        events.push({ bar: b, beat, dur: len, midi: m });
        prev = m;
        beat += len;
      });
    }
    return events;
  }

  _voice(role, ch, lo, hi, n) {
    const v = voiceChord(ch, lo, hi, n, this.prevVoicing[role], this.r);
    this.prevVoicing[role] = v;
    return v;
  }

  // ---------- bar generation ----------

  // After a pause or a seek the sounding chord was released, so the next bar must re-voice it.
  resync() { this.resyncPending = true; }

  // Jump to a bar of a journey (the current one, or one from the history).
  seek(journey, secIdx, bar = 0) {
    this.journey = journey;
    this.secIdx = secIdx;
    this.barInSec = bar;
    this.resyncPending = true;
  }

  // Start a journey after the given one: from the history if we went back, else a fresh one.
  seekNextJourney(from) {
    this.journey = from;
    this._advanceJourney();
    this.resyncPending = true;
  }

  nextBar() {
    if (!this.journey) this._newJourney();
    const fresh = this.resyncPending;
    this.resyncPending = false;
    let sec = this.journey.sections[this.secIdx];
    if (this.barInSec >= sec.bars) {
      this.secIdx++;
      this.barInSec = 0;
      if (this.secIdx >= this.journey.sections.length) this._advanceJourney();
      sec = this.journey.sections[this.secIdx];
    }
    const b = this.barInSec++;
    const I = barIntensity(sec, b, this.energy, this.prevI, fresh);
    this.prevI = I;
    const ch = sec.chords[b];
    const ev = [];

    // Landing mid-chord after a seek or pause: the chord still needs sounding.
    const chordStart = sec.starts[b] || fresh;
    const beats = sec.starts[b] ? sec.lens[b] * 4 : this._remainingBars(sec, b) * 4;
    if (chordStart) this._chordLayers(ev, sec, ch, beats, I);
    else this._layerEntries(ev, sec, ch, beats, I);
    this._ostinato(ev, sec, ch, I);
    this._melody(ev, sec, b, I);
    this._percussion(ev, sec, ch, b, I);

    const nextIdx = sec.chords.findIndex((c, i) => i > b && sec.starts[i]);
    return {
      bpm: this.journey.bpm,
      intensity: I,
      sectionId: sec.id,
      section: sec.name,
      bar: b,
      bars: sec.bars,
      chord: ch.name,
      chordStart,
      nextChord: nextIdx >= 0 ? sec.chords[nextIdx].name : this._peekNextSectionChord(),
      key: keyName(this.journey.K),
      journey: this.journey,
      secIdx: this.secIdx,
      // the fall lets the hall ring out (seeks release notes in the player instead)
      cut: b === 0 && sec.cut && !fresh,
      cutFade: 3,
      events: ev,
    };
  }

  _remainingBars(sec, b) {
    let n = 1;
    while (b + n < sec.bars && !sec.starts[b + n]) n++;
    return n;
  }

  _peekNextSectionChord() {
    const next = this.journey.sections[this.secIdx + 1];
    return next ? next.chords[0].name : '…';
  }

  _wantLayers(sec, I) {
    if (sec.id === 'dawn') return ['drone'];
    const want = ['pad', 'cello'];
    if (I > 0.1) want.push('choir');
    if (I > 0.38) want.push('bass');
    if (I > 0.52) want.push('horns');
    if (I > 0.66) want.push('trem');
    if (I > 0.8) want.push('brass');
    return want;
  }

  _chordLayers(ev, sec, ch, beats, I) {
    const att = lerp(1.6, 0.35, I);
    this.layersOn = new Set(this._wantLayers(sec, I));
    for (const layer of this.layersOn) this._emitLayer(ev, layer, ch, beats, I, att);
  }

  // During a long chord, sections whose threshold the rising intensity crosses fade in
  // mid-chord instead of waiting for the next chord change.
  _layerEntries(ev, sec, ch, beats, I) {
    for (const layer of this._wantLayers(sec, I)) {
      if (this.layersOn?.has(layer)) continue;
      this.layersOn?.add(layer);
      this._emitLayer(ev, layer, ch, beats, I, 2.2);
    }
  }

  _emitLayer(ev, layer, ch, beats, I, att) {
    const dur = beats + 0.2;
    const sus = (c, midi, vel, attack = att, release = 2) =>
      ev.push({ type: 'sus', ch: c, midi, beat: 0, dur, vel, attack, release });
    switch (layer) {
      case 'drone':
        for (const m of this._voice('drone', ch, 69, 88, 3)) sus('pad', m, 0.5, 2.5, 3);
        for (const m of this._voice('oohs', ch, 57, 71, 2)) sus('oohs', m, 0.32, 3, 3);
        break;
      case 'pad': {
        const n = I < 0.3 ? 3 : I < 0.65 ? 4 : 5;
        const [lo, hi] = I < 0.3 ? [57, 83] : [50, 79];
        for (const m of this._voice('pad', ch, lo, hi, n)) sus('pad', m, 0.32 + 0.45 * I, att, 2.4);
        break;
      }
      case 'choir': {
        const aah = smooth(0.42, 0.62, I);
        for (const m of this._voice('choir', ch, 55, 76, 4)) {
          if (aah < 1) sus('oohs', m, (0.3 + 0.4 * I) * Math.sqrt(1 - aah), att * 1.2, 2.6);
          if (aah > 0) sus('choir', m, (0.3 + 0.5 * I) * Math.sqrt(aah), att, 2.6);
        }
        break;
      }
      case 'cello':
        sus('cello', place(ch.bass, 40), 0.42 + 0.35 * I, att, 2);
        break;
      case 'bass':
        sus('bass', place(ch.bass, 28), 0.3 + 0.55 * smooth(0.38, 0.75, I), att, 2);
        break;
      case 'horns':
        for (const m of this._voice('horns', ch, 50, 67, 3)) sus('horns', m, 0.25 + 0.55 * smooth(0.52, 0.92, I), att, 1.8);
        break;
      case 'trem':
        for (const m of this._voice('trem', ch, 67, 88, 3)) sus('trem', m, 0.25 + 0.5 * smooth(0.66, 1, I), Math.max(att, 0.8), 1.8);
        break;
      case 'brass': {
        const v = 0.3 + 0.5 * smooth(0.8, 1, I);
        const a = Math.max(0.25, att * 0.7);
        for (const m of this._voice('brass', ch, 48, 70, 4)) sus('brass', m, v, a, 1.6);
        sus('brass', place(ch.bass, 36), v, a, 1.6);
        break;
      }
    }
  }

  _ostinato(ev, sec, ch, I) {
    const layers = [];
    if (I < 0.5 && ['dawn', 'stirring', 'reflect', 'resolve'].includes(sec.id)) {
      layers.push(['celesta', 74, 'sparkle', 0.24 + 0.3 * I]);
    }
    if (I > 0.04 && I < 0.88 && sec.id !== 'fall') {
      layers.push(['harp', sec.id === 'dawn' ? 69 : 57, sec.harpPat, 0.32 + 0.35 * I]);
    }
    if (I > 0.34 && !['fall', 'resolve'].includes(sec.id)) {
      layers.push(['pizz', 52, 'pulse', 0.25 + 0.45 * smooth(0.34, 1, I)]);
    }
    for (const [c, lo, pat, vel] of layers) {
      const tones = [];
      for (let m = place(ch.bass, lo); tones.length < 5; m++) if (ch.pcs.includes(pcOf(m))) tones.push(m);
      const idx = PATTERNS[pat];
      idx.forEach((t, i) => {
        if (t === null) return;
        const accent = i % 4 === 0 ? 0.08 : 0;
        ev.push({ type: 'one', ch: c, midi: tones[Math.min(t, tones.length - 1)], beat: i / 2, vel: vel + accent + (this.r() - 0.5) * 0.08 });
      });
    }
  }

  _melody(ev, sec, b, I) {
    const notes = sec.melody.filter((e) => e.bar === b);
    if (!notes.length) return;
    const pass = sec.loopLen ? Math.floor(b / sec.loopLen) : 0;
    let roles;
    switch (sec.id) {
      case 'stirring': roles = [[I > 0.36 ? 'horns' : 'cello', 0]]; break;
      case 'reflect': roles = [['cello', 0]]; break;
      case 'rising': roles = I > 0.55 ? [['melodyStr', 0], ['horns', -12]] : [['melodyStr', 0]]; break;
      case 'anthem':
        roles = pass === 0 ? [['melodyStr', 0]]
          : pass === 1 ? [['melodyStr', 0], ['choir', 0]]
            : [['melodyStr', 12], ['choir', 0], ['horns', -12]];
        if (sec.passes === 1) roles = [['melodyStr', 12], ['choir', 0], ['horns', -12]];
        break;
      default: roles = [['melodyStr', 0]];
    }
    const att = lerp(0.35, 0.12, I);
    for (const n of notes) {
      for (const [c, rawOct] of roles) {
        const oct = rawOct > 0 && n.midi + rawOct > 86 ? 0 : rawOct;
        const vel = (c === 'horns' ? 0.3 + 0.5 * I : 0.42 + 0.45 * I) * (sec.id === 'resolve' ? 0.6 : 1);
        ev.push({ type: 'sus', ch: c, midi: n.midi + oct, beat: n.beat, dur: n.dur * 1.04, vel, attack: att, release: 1 });
      }
    }
  }

  _percussion(ev, sec, ch, b, I) {
    const timp = place(ch.root, 40);
    const last = b === sec.bars - 1;
    const hit = (beat, vel, midi = timp) => ev.push({ type: 'one', ch: 'timp', midi, beat, vel });
    const roll = (start, beats, v0, v1) => {
      const step = 0.1;
      const n = Math.round(beats / step);
      for (let i = 0; i < n; i++) {
        ev.push({ type: 'one', ch: 'timp', midi: timp, beat: start + i * step, vel: lerp(v0, v1, Math.pow(i / n, 1.6)), maxDur: 0.5 });
      }
    };
    if (sec.id === 'anthem') {
      if (sec.starts[b] && I > 0.6) hit(0, 0.4 + 0.45 * I);
      else if (I > 0.86) hit(0, 0.45);
      if (I > 0.86) hit(2, 0.35, place(ch.fifth, 40));
      const loopEnd = (b + 1) % sec.loopLen === 0;
      if (loopEnd && I > 0.7 && !last) roll(2, 2, 0.12, 0.55 + 0.3 * I);
    }
    if (sec.id === 'rising' && last) roll(0, 4, 0.08, 0.8);
    if (sec.id === 'stirring' && last) roll(2, 2, 0.05, 0.35);
    if (sec.id === 'resolve' && b === sec.peakBar - 1) roll(0, 4, 0.04, 0.6);
    if (sec.id === 'resolve' && b === sec.peakBar) hit(0, 0.7);
  }
}

const PATTERNS = {
  up: [0, 1, 2, 3, 0, 1, 2, 3],
  updown: [0, 1, 2, 3, 4, 3, 2, 1],
  rock: [0, 2, 1, 2, 0, 2, 1, 2],
  wide: [0, 2, 4, 2, 1, 3, 4, 3],
  pulse: [3, 1, 3, 1, 3, 1, 3, 1],
  sparkle: [4, null, 2, null, null, 3, null, 1],
};
