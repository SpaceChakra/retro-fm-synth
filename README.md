# Retro FM Synth

A **zero-dependency, YM2612-style FM music engine** for the browser, the kind of sound the 16-bit consoles made. Songs are small JSON files of notes and patches, so a whole soundtrack costs a few KB and **no audio files at all**.

The engine behind the BOMBAZ soundtrack, from SpaceChakra. **[Open the demo](index.html)**: a song, track mutes, drum pads, and a playable lead on your keyboard.

## What's in the box

- **4-operator FM voices**: 5 algorithms, operator feedback, vibrato, mono/legato with glide, per-patch filter envelopes
- **6 tracks**: bass, lead, chords, arp, pad + a **procedural drum kit** (kick, snare, hats, clap, clave, rim, cowbell, congas, bongo, timpani, riser). Every drum is synthesized, no samples.
- **FX**: seeded stereo hall reverb, stereo ping-pong echo synced to tempo, kick-driven sidechain "pump", filter sweeps across a pattern
- **A lookahead scheduler** on the audio clock (tight timing even when the game hitches), swing, arrangements with an intro that plays once and then loops
- **Live control** for games: `mute`, `solo`, `setBpm` (tempo that rises with danger), `noteOn`/`noteOff`/`hit` for stingers, an `onStep` callback for syncing visuals to the music
- A built-in limiter + soft clip, so you can't blow the speakers

## Use

```html
<script src="retro-synth.js"></script>
<script>
  const rs = RetroSynth.create();              // or { ctx, destination } to route it yourself
  await rs.load('demo-song.json');             // a URL or an object
  button.onclick = () => { rs.resume(); rs.play(); };   // browsers need a click first

  rs.setBpm(132);                  // speed up when the Void gets close
  rs.mute('lead', true);           // strip the melody in the pause menu
  rs.hit('timp', 1);               // a drum stinger on an explosion
  rs.onStep = (step, pattern, t) => { /* flash the HUD on the beat */ };
</script>
```

Works as an ES module side-effect import too: `import './retro-synth.js'`.

## Song format (short version)

```jsonc
{
  "bpm": 118, "steps": 32, "swing": 0.04,          // steps per pattern (16ths)
  "arrangement": ["intro", "A", "A", "B"], "loopFrom": 1,
  "patches": {                                      // one FM patch per melodic track
    "bass": { "alg": 0, "ops": [{ "r": 1, "l": 1 }, { "r": 1, "l": 0.7 }, { "r": 2, "l": 0.35 }, { "r": 1, "l": 0.25 }],
              "idx": 1.1, "fb": 0.35, "mono": true, "glide": 0.02, "cut": 2400,
              "amp": { "a": 0.004, "d": 0.18, "s": 0.55, "r": 0.07 }, "mod": { "a": 0.002, "d": 0.14, "s": 0.25, "r": 0.08 } }
  },
  "drums": { "vol": 0.85, "drive": 0.25 },
  "fx": { "verb": { "size": 2.2 }, "echo": { "steps": 3 }, "pump": { "depth": 0.45 } },
  "patterns": {
    "A": {
      "bass":  [[0, 45, 2, 0.9]],                   // [step, midiNote | [chord], lengthInSteps, velocity]
      "drums": { "kick": "x...x...x...x...", "clap": "....x.......x..." }   // x = hit, X = accent
    }
  }
}
```

See `demo-song.json` for a complete example. `ops[].r` is the frequency ratio, `l` the level, `w` the waveform, `d` the detune in cents. `alg` picks how the 4 operators modulate each other (see `ALGS` in the source).

## License

MIT. Made by [SpaceChakra](https://patreon.com/spacechakra). The demo song is original and free to use too.
