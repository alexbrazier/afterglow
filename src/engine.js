/* global Tone */
// Audio engine: loads General-MIDI orchestral samples (MusyngKite soundfont, rendered to mp3)
// and plays them through a small orchestral mix (per-section channels → hall reverb → glue
// compressor → limiter). The hosted samples are only ~3s long and cut off mid-sustain, so
// sustained instruments are kept alive by chaining crossfaded segments of the sample body.

const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/';
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const sampleName = (m) => FLAT_NAMES[m % 12] + (Math.floor(m / 12) - 1);

// group drives the mixer sliders; bright = [low, high] lowpass cutoff following intensity
export const CHANNELS = {
  pad:       { file: 'string_ensemble_1', lo: 50, hi: 90, pan: -0.05, send: 0.5,  gain: 0.42, group: 'strings', bright: [1600, 11000] },
  melodyStr: { file: 'string_ensemble_1', lo: 50, hi: 96, pan: -0.3,  send: 0.45, gain: 0.62, group: 'strings', bright: [2200, 12000] },
  trem:      { file: 'tremolo_strings',   lo: 64, hi: 91, pan: -0.25, send: 0.4,  gain: 0.3,  group: 'strings', bright: [3000, 12000] },
  cello:     { file: 'cello',             lo: 36, hi: 70, pan: 0.3,   send: 0.35, gain: 0.6,  group: 'strings', bright: [1200, 8000] },
  bass:      { file: 'contrabass',        lo: 26, hi: 44, pan: 0.4,   send: 0.3,  gain: 0.75, group: 'strings', bright: [700, 4000] },
  choir:     { file: 'choir_aahs',        lo: 52, hi: 86, pan: 0.05,  send: 0.6,  gain: 0.5,  group: 'choir',   bright: [2200, 10000] },
  oohs:      { file: 'voice_oohs',        lo: 52, hi: 80, pan: -0.05, send: 0.65, gain: 0.5,  group: 'choir',   bright: [1800, 8000] },
  horns:     { file: 'french_horn',       lo: 38, hi: 77, pan: -0.18, send: 0.45, gain: 0.45, group: 'brass',   bright: [1200, 7000] },
  brass:     { file: 'brass_section',     lo: 34, hi: 74, pan: 0.15,  send: 0.4,  gain: 0.32, group: 'brass',   bright: [1200, 8000] },
  harp:      { file: 'orchestral_harp',   lo: 50, hi: 90, pan: -0.45, send: 0.5,  gain: 0.5,  group: 'texture', bright: [9000, 14000] },
  pizz:      { file: 'pizzicato_strings', lo: 48, hi: 80, pan: 0.25,  send: 0.35, gain: 0.45, group: 'texture', bright: [5000, 12000] },
  celesta:   { file: 'celesta',           lo: 70, hi: 98, pan: 0.35,  send: 0.6,  gain: 0.3,  group: 'texture', bright: [9000, 14000] },
  timp:      { file: 'timpani',           lo: 38, hi: 55, pan: 0.0,   send: 0.4,  gain: 0.8,  group: 'perc',    bright: [3000, 9000] },
};

const XFADE = 0.45; // seconds of overlap between sustain segments
const FADE_IN = new Float32Array(32).map((_, i) => Math.sin((i / 31) * Math.PI / 2));
const FADE_OUT = new Float32Array(32).map((_, i) => Math.cos((i / 31) * Math.PI / 2));

export class Engine {
  constructor() {
    this.samples = {}; // file -> [{ midi, buf, trim }]
    this.voices = new Set();
    this.ch = {};
    this.mix = { strings: 1, choir: 1, brass: 1, texture: 1, perc: 1 };
  }

  get ctx() { return Tone.getContext(); }
  now() { return this.ctx.currentTime; }

  async init(onProgress = () => {}) {
    await Tone.start();
    const ctx = this.ctx;

    this.master = new Tone.Gain(0);
    this.swell = new Tone.Gain(0.5);
    this.dryBus = new Tone.Gain(1);
    this.reverb = new Tone.Reverb({ decay: 7.5, preDelay: 0.035 });
    this.revReturn = new Tone.Gain(0.9);
    this.comp = new Tone.Compressor({ threshold: -16, ratio: 2.5, attack: 0.08, release: 0.5, knee: 12 });
    this.limiter = new Tone.Limiter(-1.5);
    this.dryBus.connect(this.swell);
    this.reverb.chain(this.revReturn, this.swell);
    // Measured climax sat around -25 dBFS RMS; makeup gain brings it to roughly -15 before the limiter.
    this.makeup = new Tone.Gain(3);
    this.swell.chain(this.makeup, this.comp, this.limiter, this.master, Tone.getDestination());
    this.recorder = new Tone.Recorder();
    this.master.connect(this.recorder);

    for (const [name, def] of Object.entries(CHANNELS)) {
      const input = new Tone.Gain(def.gain);
      const filter = new Tone.Filter({ type: 'lowpass', frequency: def.bright[0], rolloff: -12, Q: 0.4 });
      const panner = new Tone.Panner(def.pan);
      const mute = new Tone.Gain(1);
      const send = new Tone.Gain(def.send);
      // metered before the mute so a muted lane still shows what it would be playing
      const meter = new Tone.Meter({ normalRange: true, smoothing: 0.5 });
      input.chain(filter, panner, mute);
      panner.connect(meter);
      mute.connect(this.dryBus);
      mute.connect(send);
      send.connect(this.reverb);
      this.ch[name] = { def, input, filter, mute, meter, node: input.input, muted: false, solo: false };
    }

    const genReverb = this.reverb.generate();

    // Sample set per file: every minor third across the union of channel ranges.
    const wanted = {};
    for (const def of Object.values(CHANNELS)) {
      const set = (wanted[def.file] ??= new Set());
      const start = Math.max(21, Math.floor((def.lo - 1) / 3) * 3);
      const end = Math.min(108, Math.ceil((def.hi + 1) / 3) * 3);
      for (let m = start; m <= end; m += 3) set.add(m);
    }
    const jobs = [];
    for (const [file, set] of Object.entries(wanted)) for (const midi of set) jobs.push({ file, midi });

    let done = 0;
    let failed = 0;
    const loadOne = async ({ file, midi }) => {
      try {
        const res = await fetch(`${SF_BASE}${file}-mp3/${sampleName(midi)}.mp3`);
        if (!res.ok) throw new Error(res.status);
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        (this.samples[file] ??= []).push({ midi, buf, trim: leadingSilence(buf) });
      } catch (e) {
        console.warn('sample failed', file, midi, e);
        failed++;
      }
      onProgress(++done / jobs.length);
    };
    const queue = [...jobs];
    await Promise.all(Array.from({ length: 10 }, async () => {
      while (queue.length) await loadOne(queue.shift());
    }));
    if (failed > jobs.length / 2) throw new Error('could not download the instrument samples — check your connection');
    for (const list of Object.values(this.samples)) list.sort((a, b) => a.midi - b.midi);
    await genReverb;
  }

  _sample(file, midi) {
    const list = this.samples[file];
    if (!list?.length) return null;
    let best = list[0];
    for (const s of list) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
    return { ...best, rate: Math.pow(2, (midi - best.midi) / 12) };
  }

  // Sustained note of arbitrary length: attack segment, then looping crossfaded body segments.
  sustain(chName, midi, time, dur, vel, attack = 0.3, release = 1.5) {
    const ch = this.ch[chName];
    const s = ch && this._sample(ch.def.file, midi);
    if (!s) return;
    const ctx = this.ctx;
    const { buf, trim, rate } = s;
    const peak = Math.min(1, vel * vel);
    const holdEnd = Math.max(time + dur, time + attack);
    const stopAt = holdEnd + release * 1.6;

    const env = ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + attack);
    env.gain.setValueAtTime(peak, holdEnd);
    env.gain.setTargetAtTime(0, holdEnd, release / 3);
    env.connect(ch.node);

    const bufEnd = buf.duration - 0.06;
    const voice = { env, srcs: [], stopAt, ch: chName, midi, start: time, noteEnd: holdEnd };
    let t = time;
    let off = trim;
    let first = true;
    while (t < stopAt) {
      const segEnd = t + (bufEnd - off) / rate;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = first ? 1 : 0;
      if (!first) g.gain.setValueCurveAtTime(FADE_IN, t, XFADE);
      if (segEnd < stopAt) g.gain.setValueCurveAtTime(FADE_OUT, segEnd - XFADE, XFADE);
      src.connect(g);
      g.connect(env);
      src.start(t, off);
      src.stop(Math.min(segEnd, stopAt + 0.05));
      voice.srcs.push(src);
      if (segEnd >= stopAt) break;
      t = segEnd - XFADE;
      off = trim + 0.5 + Math.random() * 0.4;
      first = false;
    }
    this._track(voice);
  }

  // Plucked / struck note: plays the sample once (optionally damped after maxDur).
  oneshot(chName, midi, time, vel, maxDur = null) {
    const ch = this.ch[chName];
    const s = ch && this._sample(ch.def.file, midi);
    if (!s) return;
    const ctx = this.ctx;
    const { buf, trim, rate } = s;
    const natural = (buf.duration - trim) / rate;
    const end = maxDur ? Math.min(natural, maxDur) : natural;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const env = ctx.createGain();
    env.gain.value = Math.min(1, vel * vel);
    env.gain.setTargetAtTime(0, Math.max(time, time + end - 0.35), 0.12);
    src.connect(env);
    env.connect(ch.node);
    src.start(time, trim);
    src.stop(time + end + 0.1);
    this._track({ env, srcs: [src], stopAt: time + end + 0.1, ch: chName, midi, start: time, noteEnd: time + Math.min(end, 0.45) });
  }

  // Notes currently sounding (or just struck) on each channel, for the instruments view.
  activeNotes() {
    const now = this.now();
    const out = {};
    for (const v of this.voices) {
      if (v.start <= now && now < v.noteEnd) (out[v.ch] ??= new Set()).add(v.midi);
    }
    return out;
  }

  level(chName) { return this.ch[chName].meter.getValue(); }

  setMute(chName, on) { this.ch[chName].muted = on; this._applyMutes(); }
  setSolo(chName, on) { this.ch[chName].solo = on; this._applyMutes(); }

  _applyMutes() {
    const anySolo = Object.values(this.ch).some((c) => c.solo);
    for (const c of Object.values(this.ch)) {
      const audible = !c.muted && (!anySolo || c.solo);
      c.mute.gain.rampTo(audible ? 1 : 0, 0.08);
    }
  }

  _track(voice) {
    this.voices.add(voice);
    voice.srcs[voice.srcs.length - 1].onended = () => {
      this.voices.delete(voice);
      voice.env.disconnect();
    };
  }

  // Fade every scheduled/sounding note out from `time` (used for the dramatic drop and on stop).
  releaseAll(time, fade = 0.6) {
    for (const v of this.voices) {
      if (v.stopAt <= time) continue;
      const p = v.env.gain;
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(time); else p.cancelScheduledValues(time);
      p.setTargetAtTime(0, time, fade / 3);
      for (const s of v.srcs) {
        try { s.stop(time + fade * 2); } catch { /* already stopped */ }
      }
      v.stopAt = time + fade * 2;
      v.noteEnd = Math.min(v.noteEnd, time);
    }
  }

  // Macro dynamics: overall swell plus per-channel brightness, ramped across a bar.
  setIntensity(I, time, ramp) {
    this.swell.gain.rampTo(0.22 + 0.78 * Math.pow(I, 0.75), ramp, time);
    const x = Math.pow(I, 0.8);
    for (const ch of Object.values(this.ch)) {
      const [lo, hi] = ch.def.bright;
      ch.filter.frequency.rampTo(lo * Math.pow(hi / lo, x), ramp, time);
    }
  }

  setMix(group, level) {
    this.mix[group] = level;
    for (const ch of Object.values(this.ch)) {
      if (ch.def.group === group) ch.input.gain.rampTo(ch.def.gain * level, 0.2);
    }
  }

  setReverb(level) { this.revReturn.gain.rampTo(level, 0.2); }
  setVolume(v, ramp = 0.3) { this.master.gain.rampTo(v, ramp); }
}

function leadingSilence(buf) {
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) > 0.003) return Math.max(0, i / buf.sampleRate - 0.004);
  }
  return 0;
}
