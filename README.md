# Afterglow

An endless, generative orchestral + choral score in the style of a slow, swelling film cue
(A minor / C major, ~70 BPM, drone → pedal build → lift → descending-bass anthem → drop → resolve).

## Run

Live at https://alexbrazier.github.io/afterglow/ (deployed by `.github/workflows/pages.yml` on
every push to `main`). Locally:

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765 and press **Play**. Samples (~4 MB) stream from the MusyngKite
General-MIDI soundfont on first play, so an internet connection is needed.

## How it works

- `src/composer.js` — the music. Each *journey* is a chain of sections whose harmony, theme,
  lengths, tempo and (sometimes) key are drawn from a seeded RNG, following the arc measured
  from the reference track. Chords are voice-led per instrument; melodies are generated per
  section, and each anthem has one theme restated with growing orchestration.
- `src/engine.js` — the sound. Loads samples, keeps sustained notes alive past the 3 s sample
  length by crossfading body segments, and mixes through a hall reverb, glue compressor and
  limiter. Intensity drives an overall swell and per-section brightness.
- `src/main.js` — lookahead scheduler, UI, journey map, recording (saves `.webm`).

Tweak the feel in `composer.js`: `ANTHEMS`, `RISING`, `STIRRING_MARKOV` (progressions),
section `int` ranges (dynamics) and `_chordLayers` (which instruments enter when).
