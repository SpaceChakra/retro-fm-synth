/*! retro-synth.js — zero-dependency YM2612-style FM music runtime (Web Audio).
 *  From SpaceChakra (the engine behind the BOMBAZ soundtrack). MIT licensed — see LICENSE.
 *
 * Load it as a classic <script src="retro-synth.js"> or `import './retro-synth.js'`;
 * either way it defines a global `RetroSynth`.
 *
 *   const rs = RetroSynth.create();            // optional {ctx, destination}
 *   await rs.load(songJson);                   // object or URL to exported JSON
 *   rs.play();  rs.pause();  rs.stop();
 *   rs.noteOn('lead', 69); rs.noteOff('lead', 69); rs.hit('snare');
 *   rs.mute('lead', true); rs.setVolume(0.8); rs.onStep = (step, pat, t) => {};
 * Optional per-song extras (a song without them plays exactly as before):
 *   patches.arp / patches.pad    two more melodic tracks
 *   fx: { verb:{size,damp,wet}, echo:{steps,fb,wet}, pump:{depth,rel} }
 *   patch: pan, pump (duck from kick/timp), verb, echo (send levels), fenv:{hi,lo,d} (filter envelope)
 *   kit: verb (send level)
 *   pattern.sweep: { bass:[fromHz,toHz], master:[fromHz,toHz] }  filter ramp across the pattern
 *   loopFrom: arrangement index to loop back to, so an intro plays only once
 * Browsers require a user gesture before audio: call rs.resume() from a click/key handler. */
(function (G) {
  'use strict';
  // Operator algorithms: m = [modulator, target] pairs, c = carriers. op index 3 carries feedback.
  var ALGS = [
    { m: [[3, 2], [2, 1], [1, 0]], c: [0] },        // 0: 4→3→2→1 serial
    { m: [[3, 2], [1, 0]], c: [0, 2] },             // 1: two stacks
    { m: [[1, 0], [2, 0], [3, 0]], c: [0] },        // 2: three mods → 1
    { m: [[3, 0]], c: [0, 1, 2] },                  // 3: one stack + 2 pure carriers
    { m: [[3, 0], [3, 1], [3, 2]], c: [0, 1, 2] }   // 4: one mod → three carriers
  ];
  var TRACKS = ['bass', 'lead', 'chords', 'arp', 'pad', 'drums'];
  var MELODIC = ['bass', 'lead', 'chords', 'arp', 'pad'];
  var LANES = ['kick', 'snare', 'clhat', 'ophat', 'clave', 'rim', 'cowbell', 'congaHi', 'congaLo', 'bongo', 'timp', 'clap', 'riser'];
  var mtof = function (n) { return 440 * Math.pow(2, (n - 69) / 12); };

  // Events are scheduled ahead of time, so hold the automation value *at t* rather than "now".
  function hold(p, t) { if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t); }
  function env(p, t, peak, a, d, s) {
    a = Math.max(a, 0.001); hold(p, t);
    p.setTargetAtTime(peak, t, a / 3);
    p.setTargetAtTime(peak * s, t + a, Math.max(d, 0.005) / 3);
  }
  function rel(p, t, r) { hold(p, t); p.setTargetAtTime(0, t, Math.max(r, 0.005) / 5); }
  function glideTo(p, v, t, g) { hold(p, t); if (g > 0) p.setTargetAtTime(v, t, g / 3); else p.setValueAtTime(v, t); }

  // One FM voice: 4 operators + feedback + vibrato, amp envelope on carrier sum.
  function Voice(ctx, P, out, bend, t0) {
    var alg = ALGS[P.alg] || ALGS[0], self = this, mods = {};
    alg.m.forEach(function (m) { mods[m[0]] = 1; });
    this.ctx = ctx; this.P = P; this.alg = alg; this.mods = mods;
    this.amp = ctx.createGain(); this.amp.gain.value = 0;
    if (P.fenv) {
      this.vf = ctx.createBiquadFilter(); this.vf.type = 'lowpass'; this.vf.Q.value = P.fenv.q || 1;
      this.vf.frequency.value = P.fenv.lo; this.amp.connect(this.vf); this.vf.connect(out);
    } else this.amp.connect(out);
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = P.vibR || 5.5;
    this.lfoG = ctx.createGain(); this.lfoG.gain.value = 0; this.lfo.connect(this.lfoG); this.lfo.start(t0 || 0);
    this.ops = P.ops.map(function (o, i) {
      var osc = ctx.createOscillator(), g = ctx.createGain(), op = { o: o, osc: osc, g: g };
      osc.type = o.w || 'sine'; osc.connect(g); self.lfoG.connect(osc.detune);
      if (mods[i]) { op.depth = ctx.createGain(); g.connect(op.depth); g.gain.value = 0; }
      else g.gain.value = (o.l == null ? 1 : o.l) / alg.c.length;
      osc.start(t0 || 0); return op;
    });
    alg.m.forEach(function (m) { self.ops[m[0]].depth.connect(self.ops[m[1]].osc.frequency); });
    alg.c.forEach(function (i) { self.ops[i].g.connect(self.amp); });
    var f = this.ops[3]; f.fb = ctx.createGain(); f.fb.gain.value = 0;
    f.dl = ctx.createDelay(0.01); f.dl.delayTime.value = 0; f.osc.connect(f.fb); f.fb.connect(f.dl); f.dl.connect(f.osc.frequency);
    this.setBend(bend || 0, ctx.currentTime);
    this.note = -1; this.gate = false;
  }
  Voice.prototype.ratio = function (i) { var o = this.ops[i].o; return o.r * (this.mods[i] ? (this.P.harm || 1) : 1); };
  Voice.prototype.setFreq = function (n, t, g) {
    var P = this.P, f0 = mtof(n), self = this;
    this.ops.forEach(function (op, i) {
      var fr = f0 * self.ratio(i);
      glideTo(op.osc.frequency, fr, t, g);
      if (op.depth) glideTo(op.depth.gain, fr * (P.idx == null ? 1 : P.idx), t, g);
    });
    glideTo(this.ops[3].fb.gain, (P.fb || 0) * f0 * this.ratio(3) * 1.5, t, g);
  };
  Voice.prototype.setBend = function (semi, t) {
    var det = this.P.det || 0, self = this;
    this.ops.forEach(function (op, i) {
      var spread = self.alg.c.indexOf(i) >= 0 ? det * (i % 2 ? 1 : -1) : 0;
      op.osc.detune.setTargetAtTime((op.o.d || 0) + spread + semi * 100, t, 0.01);
    });
  };
  Voice.prototype.on = function (n, t, vel, legato) {
    var P = this.P, A = P.amp, M = P.mod, self = this;
    this.setFreq(n, t, legato ? (P.glide || 0) : (this.note < 0 || !P.mono ? 0 : (P.glide || 0)));
    this.note = n; this.gate = true;
    if (legato) return;
    if (this.vf) {
      var ff = this.vf.frequency; hold(ff, t);
      ff.setValueAtTime(P.fenv.hi, t); ff.setTargetAtTime(P.fenv.lo, t, Math.max(P.fenv.d, 0.005) / 3);
    }
    env(this.amp.gain, t, vel, A.a, A.d, A.s);
    this.ops.forEach(function (op, i) { if (self.mods[i]) env(op.g.gain, t, op.o.l, M.a, M.d, M.s); });
    var lg = this.lfoG.gain; lg.cancelScheduledValues(t); lg.setValueAtTime(0, t);
    if (P.vibD) lg.linearRampToValueAtTime(P.vibD, t + 0.35);
  };
  Voice.prototype.off = function (t) {
    var P = this.P, self = this; this.gate = false;
    rel(this.amp.gain, t, P.amp.r);
    this.ops.forEach(function (op, i) { if (self.mods[i]) rel(op.g.gain, t, P.mod.r); });
    return t + P.amp.r + 0.05;
  };
  Voice.prototype.kill = function (t) {
    t = Math.max(t, this.ctx.currentTime);
    this.ops.forEach(function (op) { op.osc.stop(t); }); this.lfo.stop(t);
    var a = this.amp, vf = this.vf; setTimeout(function () { a.disconnect(); if (vf) vf.disconnect(); }, (t - this.ctx.currentTime) * 1000 + 100);
  };

  // A channel: patch, filter, gain, live voices (mono keeps one persistent voice).
  function Channel(eng, name) {
    var c = eng.ctx; this.eng = eng; this.name = name;
    this.filt = c.createBiquadFilter(); this.filt.type = 'lowpass';
    this.gain = c.createGain(); this.filt.connect(this.gain); this.gain.connect(eng.bus);
    this.voices = {}; this.mono = null; this.held = []; this.bend = 0; this.vol = 0.8; this.muted = false; this.solo = false;
  }
  // keep=true applies live (non-structural) tweaks without rebuilding a held mono voice.
  Channel.prototype.setPatch = function (P, keep) {
    var t = this.eng.ctx.currentTime; this.P = P;
    if (this.swept) { this.filt.frequency.cancelScheduledValues(t); this.swept = false; }
    this.route(P);
    this.filt.frequency.setTargetAtTime(P.cut || 18000, t, 0.01); this.filt.Q.setTargetAtTime(P.q || 0.7, t, 0.01);
    this.vol = P.vol == null ? 0.8 : P.vol; this.eng._mix();
    if (this.mono && keep) this.mono.P = P;
    else if (this.mono) { this.mono.kill(t + 0.05); this.mono.off(t); this.mono = null; }
  };
  // Pan, pump and sends are wired only when a patch asks for them.
  Channel.prototype.route = function (P) {
    var e = this.eng, c = e.ctx, key = [P.pan || 0, P.pump ? 1 : 0, P.verb || 0, P.echo || 0].join();
    if (key === (this.rk || '0,0,0,0')) return;
    this.rk = key; this.gain.disconnect();
    var dest = P.pump ? e.pumpG : e.bus, last = this.gain;
    if (P.pan) {
      if (!this.panner) this.panner = c.createStereoPanner();
      this.panner.disconnect(); this.panner.pan.value = P.pan; last.connect(this.panner); last = this.panner;
    }
    last.connect(dest);
    if (P.verb && e.verbIn) { if (!this.sV) this.sV = c.createGain(); this.sV.disconnect(); this.sV.gain.value = P.verb; this.gain.connect(this.sV); this.sV.connect(e.verbIn); }
    if (P.echo && e.echoIn) { if (!this.sE) this.sE = c.createGain(); this.sE.disconnect(); this.sE.gain.value = P.echo; this.gain.connect(this.sE); this.sE.connect(e.echoIn); }
  };
  Channel.prototype.on = function (n, t, vel) {
    var P = this.P; vel = vel == null ? 0.9 : vel; this.eng._ev(this.name, n, t, true);
    if (P.mono) {
      var legato = this.held.length > 0 && P.glide > 0;
      if (!this.mono) this.mono = new Voice(this.eng.ctx, P, this.filt, this.bend, t);
      this.held = this.held.filter(function (x) { return x !== n; }); this.held.push(n);
      this.mono.on(n, t, vel, legato); return;
    }
    if (this.voices[n]) this.off(n, t);
    var v = new Voice(this.eng.ctx, P, this.filt, this.bend, t); v.on(n, t, vel / 2); this.voices[n] = v;
  };
  Channel.prototype.off = function (n, t) {
    this.eng._ev(this.name, n, t, false);
    if (this.P.mono) {
      this.held = this.held.filter(function (x) { return x !== n; });
      if (!this.mono || this.mono.note !== n) return;
      if (this.held.length) this.mono.on(this.held[this.held.length - 1], t, 0.9, true); else this.mono.off(t);
      return;
    }
    var v = this.voices[n]; if (!v) return; delete this.voices[n]; v.kill(v.off(t));
  };
  Channel.prototype.setBend = function (semi) {
    var t = this.eng.ctx.currentTime, vs = this.voices; this.bend = semi;
    if (this.mono) this.mono.setBend(semi, t);
    for (var k in vs) vs[k].setBend(semi, t);
  };
  Channel.prototype.allOff = function () {
    var t = this.eng.ctx.currentTime; for (var k in this.voices) this.off(+k, t);
    this.held = []; if (this.mono) this.mono.off(t);
  };

  // Procedural drum kit: noise bursts, pitch sweeps and FM pings.
  function Drums(eng) {
    var c = eng.ctx, len = c.sampleRate, b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.eng = eng; this.noise = b; this.name = 'drums';
    this.shaper = c.createWaveShaper(); this.gain = c.createGain(); this.shaper.connect(this.gain); this.gain.connect(eng.bus);
    this.vol = 0.8; this.muted = false; this.solo = false; this.setKit({});
  }
  Drums.prototype.setKit = function (K) {
    this.K = K; this.vol = K.vol == null ? 0.8 : K.vol;
    if (this.sV) this.sV.gain.value = K.verb || 0;
    else if (K.verb && this.eng.verbIn) { this.sV = this.eng.ctx.createGain(); this.sV.gain.value = K.verb; this.gain.connect(this.sV); this.sV.connect(this.eng.verbIn); }
    // Gentle saturation, oversampled: a steep curve folds hat/snare noise back down as static.
    var n = 1024, cv = new Float32Array(n), k = (K.drive || 0) * 8;
    for (var i = 0; i < n; i++) { var x = i * 2 / n - 1; cv[i] = k ? (1 + k) * x / (1 + k * Math.abs(x)) : x; }
    this.shaper.curve = cv; this.shaper.oversample = '4x'; if (this.eng.ctx) this.eng._mix();
  };
  Drums.prototype._env = function (t, peak, dec) {
    var g = this.eng.ctx.createGain(); g.connect(this.shaper);
    g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.001, t + dec); return g;
  };
  Drums.prototype._osc = function (type, f, t, dec, peak, f2) {
    var o = this.eng.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dec * 0.4);
    o.connect(this._env(t, peak, dec)); o.start(t); o.stop(t + dec + 0.05); return o;
  };
  Drums.prototype._noise = function (t, dec, peak, type, f, q) {
    var c = this.eng.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter();
    s.buffer = this.noise; fl.type = type; fl.frequency.value = f; fl.Q.value = q || 0.7;
    s.connect(fl); fl.connect(this._env(t, peak, dec)); s.start(t, Math.random() * 0.5); s.stop(t + dec + 0.05);
  };
  Drums.prototype.hit = function (lane, t, vel) {
    var K = this.K, tu = K.tune || 1, de = K.decay || 1, hp = K.hp || 7000, v = vel == null ? 0.9 : vel, c = this.eng.ctx;
    t = t || c.currentTime; this.eng._ev('drums', lane, t, true);
    if (lane === 'kick' || lane === 'timp') this.eng._duck(t);
    switch (lane) {
      case 'kick': this._osc('sine', 160 * tu, t, 0.38 * de, v, 42 * tu); this._noise(t, 0.012, v * 0.4, 'lowpass', 3000); break;
      case 'snare': this._noise(t, 0.2 * de, v * 0.7, 'highpass', 1200 * (K.snap || 1)); this._osc('triangle', 190 * tu, t, 0.1 * de, v * 0.6, 150 * tu); break;
      case 'clhat': this._noise(t, 0.04 * de, v * 0.32, 'bandpass', hp * 1.2, 0.9); break;
      case 'ophat': this._noise(t, 0.28 * de, v * 0.3, 'bandpass', hp * 1.1, 0.8); break;
      case 'clave': this._osc('triangle', 2500 * tu, t, 0.06 * de, v * 0.55); break;
      case 'rim': this._osc('square', 1700 * tu, t, 0.025, v * 0.25); this._noise(t, 0.03, v * 0.4, 'bandpass', 3500, 4); break;
      case 'cowbell': {
        var bp = c.createBiquadFilter(), g = this._env(t, v * 0.35, 0.35 * de); bp.type = 'bandpass'; bp.frequency.value = 900 * tu; bp.Q.value = 2; bp.connect(g);
        [540, 800].forEach(function (f) { var o = c.createOscillator(); o.type = 'square'; o.frequency.value = f * tu; o.connect(bp); o.start(t); o.stop(t + 0.4 * de); });
        break;
      }
      case 'congaHi': this._fmPing(330 * tu, t, 0.2 * de, v * 0.7); break;
      case 'congaLo': this._fmPing(220 * tu, t, 0.26 * de, v * 0.75); break;
      case 'bongo': this._fmPing(520 * tu, t, 0.12 * de, v * 0.6); break;
      case 'timp':
        this._osc('sine', 72 * tu, t, 1.5 * de, v, 44 * tu);
        this._osc('triangle', 150 * tu, t, 0.3 * de, v * 0.3, 84 * tu);
        this._noise(t, 0.03, v * 0.45, 'lowpass', 1600);
        break;
      case 'clap':
        [0, 0.011, 0.023].forEach(function (d) { this._noise(t + d, 0.014, v * 0.45, 'bandpass', 1500, 1.3); }, this);
        this._noise(t + 0.03, 0.17 * de, v * 0.42, 'bandpass', 1350, 0.9);
        break;
      case 'riser': this._riser(t, v); break;
    }
  };
  // Filtered noise climbing for two bars into the next downbeat.
  Drums.prototype._riser = function (t, v) {
    var c = this.eng.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    var len = 32 * 15 / this.eng.song.bpm;
    s.buffer = this.noise; s.loop = true; fl.type = 'bandpass'; fl.Q.value = 1.4;
    fl.frequency.setValueAtTime(220, t); fl.frequency.exponentialRampToValueAtTime(7500, t + len);
    g.gain.setValueAtTime(0.0008, t); g.gain.exponentialRampToValueAtTime(v * 0.5, t + len * 0.97); g.gain.linearRampToValueAtTime(0, t + len);
    s.connect(fl); fl.connect(g); g.connect(this.shaper); s.start(t); s.stop(t + len + 0.02);
  };
  Drums.prototype._fmPing = function (f, t, dec, v) {
    var c = this.eng.ctx, m = c.createOscillator(), mg = c.createGain();
    m.frequency.value = f * 1.5; mg.gain.setValueAtTime(f * (this.K.fm == null ? 0.8 : this.K.fm), t); mg.gain.exponentialRampToValueAtTime(1, t + dec * 0.3);
    var o = this._osc('sine', f * 1.12, t, dec, v, f); m.connect(mg); mg.connect(o.frequency); m.start(t); m.stop(t + dec + 0.05);
  };

  // Stereo hall tail: decaying noise that darkens as it fades. Seeded, so renders repeat exactly.
  function impulse(c, size, damp) {
    var sr = c.sampleRate, n = Math.floor(size * sr), b = c.createBuffer(2, n, sr), seed = 22769;
    for (var ch = 0; ch < 2; ch++) {
      var d = b.getChannelData(ch), y = 0;
      for (var i = 0; i < n; i++) {
        seed = (seed * 16807) % 2147483647;
        var w = seed / 1073741823.5 - 1, k = i / n;
        y += Math.max(0.02, 0.9 - k * damp * 1.2) * (w - y);
        d[i] = y * Math.pow(10, -3 * k) * Math.min(1, i / (sr * 0.004));
      }
    }
    return b;
  }

  function Engine(opt) {
    opt = opt || {};
    var c = this.ctx = opt.ctx || new (G.AudioContext || G.webkitAudioContext)();
    this.bus = c.createGain(); this.bus.gain.value = 0.6;
    this.filter = c.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = 20000;
    this.master = c.createGain(); this.master.gain.value = 0.8;
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -4; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.003; this.limiter.release.value = 0.12;
    this.bus.connect(this.filter); this.filter.connect(this.master); this.master.connect(this.limiter);
    this.pumpG = c.createGain(); this.pumpG.connect(this.bus);
    // Compressor adds makeup gain, so trim and soft-clip after it to guarantee |out| < 1.
    this.trim = c.createGain(); this.trim.gain.value = 0.6; this.out = c.createWaveShaper();
    var cv = new Float32Array(2048); for (var i = 0; i < 2048; i++) cv[i] = Math.tanh((i / 1023.5 - 1) * 1.5) / Math.tanh(1.5);
    this.out.curve = cv; this.limiter.connect(this.trim); this.trim.connect(this.out); this.out.connect(opt.destination || c.destination);
    this.ch = {}; var self = this;
    MELODIC.forEach(function (n) { self.ch[n] = new Channel(self, n); });
    this.ch.drums = new Drums(this);
    this.step = 0; this.arrPos = 0; this.playing = false; this.loopPattern = null;
    this.onStep = null; this.onNote = null;
  }
  Engine.prototype.resume = function () { return this.ctx.resume(); };
  Engine.prototype.load = function (song) {
    var self = this;
    if (typeof song === 'string') return fetch(song).then(function (r) { return r.json(); }).then(function (j) { return self.load(j); });
    this.song = song; this._setFx(song.fx);
    MELODIC.forEach(function (n) { if (song.patches[n]) self.ch[n].setPatch(song.patches[n]); else self.ch[n].P = null; });
    this.ch.drums.setKit(song.drums || {});
    var m = song.master || {}; this.setFilter(m.cut || 20000, m.q || 0.7); this.setVolume(m.vol == null ? 0.8 : m.vol);
    var mix = song.mix || {}; TRACKS.forEach(function (n) { if (mix[n]) self.mute(n, !!mix[n].mute); });
    this.step = 0; this.arrPos = 0; return Promise.resolve(this);
  };
  // Hall and stereo echo, built the first time a song asks for them.
  Engine.prototype._setFx = function (f) {
    f = f || {}; var c = this.ctx, t = c.currentTime;
    this.pumpCfg = f.pump || null;
    if (this.fxOn || f.pump) { this.pumpG.gain.cancelScheduledValues(t); this.pumpG.gain.setValueAtTime(1, t); }
    if (!f.verb && !f.echo && !this.fxOn) return;
    if (!this.fxOn) {
      this.fxOn = true;
      this.verbIn = c.createGain(); this.verbPre = c.createDelay(0.2); this.verbPre.delayTime.value = 0.024;
      this.conv = c.createConvolver(); this.verbWet = c.createGain();
      this.verbIn.connect(this.verbPre); this.verbPre.connect(this.conv); this.conv.connect(this.verbWet); this.verbWet.connect(this.bus);
      this.echoIn = c.createGain(); this.echoL = c.createDelay(2); this.echoR = c.createDelay(2);
      this.echoFb = c.createGain(); this.echoWet = c.createGain();
      var mg = c.createChannelMerger(2);
      this.echoIn.connect(this.echoL); this.echoL.connect(mg, 0, 0); this.echoR.connect(mg, 0, 1);
      this.echoL.connect(this.echoFb); this.echoFb.connect(this.echoR);
      var back = c.createGain(); this.echoR.connect(back); back.connect(this.echoL); this.echoBack = back;
      mg.connect(this.echoWet); this.echoWet.connect(this.bus);
    }
    this.verbWet.gain.value = f.verb ? (f.verb.wet == null ? 0.8 : f.verb.wet) : 0;
    this.echoWet.gain.value = f.echo ? (f.echo.wet == null ? 0.5 : f.echo.wet) : 0;
    this.echoFb.gain.value = this.echoBack.gain.value = f.echo ? (f.echo.fb == null ? 0.35 : f.echo.fb) : 0;
    this.echoSteps = f.echo ? f.echo.steps || 3 : 0;
    this._setEchoTime();
    if (f.verb) {
      var size = f.verb.size || 2.5, damp = f.verb.damp == null ? 0.7 : f.verb.damp, key = size + ':' + damp;
      if (key !== this.irKey) { this.irKey = key; this.conv.buffer = impulse(c, size, damp); }
    }
  };
  Engine.prototype._setEchoTime = function () {
    if (!this.echoSteps) return;
    var d = Math.min(1.9, this.echoSteps * 15 / this.song.bpm), t = this.ctx.currentTime;
    this.echoL.delayTime.setTargetAtTime(d, t, 0.05); this.echoR.delayTime.setTargetAtTime(d, t, 0.05);
  };
  Engine.prototype.setBpm = function (bpm) { this.song.bpm = bpm; this._setEchoTime(); };
  // Kick/timp breathing: pumped tracks drop, then swell back.
  Engine.prototype._duck = function (t) {
    var p = this.pumpCfg; if (!p) return;
    var g = this.pumpG.gain, rel = p.rel == null ? 0.22 : p.rel;
    g.setTargetAtTime(1 - (p.depth == null ? 0.5 : p.depth), t, 0.004);
    g.setTargetAtTime(1, t + 0.03, rel / 3);
  };
  Engine.prototype._mix = function () {
    var anySolo = false, ch = this.ch, t = this.ctx.currentTime, n;
    for (n in ch) if (ch[n].solo) anySolo = true;
    for (n in ch) { var c = ch[n], on = !c.muted && (!anySolo || c.solo); c.gain.gain.setTargetAtTime(on ? c.vol : 0, t, 0.01); }
  };
  Engine.prototype._ev = function (tr, n, t, on) { var f = this.onNote; if (f) f(tr, n, t, on); };
  Engine.prototype.mute = function (tr, v) { this.ch[tr].muted = v; this._mix(); };
  Engine.prototype.solo = function (tr, v) { this.ch[tr].solo = v; this._mix(); };
  Engine.prototype.setVolume = function (v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); };
  Engine.prototype.setFilter = function (cut, q) {
    var t = this.ctx.currentTime; this.filter.frequency.setTargetAtTime(cut, t, 0.01); if (q != null) this.filter.Q.setTargetAtTime(q, t, 0.01);
  };
  Engine.prototype.setPatch = function (tr, P, keep) { if (tr === 'drums') this.ch.drums.setKit(P); else this.ch[tr].setPatch(P, keep); };
  Engine.prototype.noteOn = function (tr, n, vel, t) { this.ch[tr].on(n, t || this.ctx.currentTime, vel); };
  Engine.prototype.noteOff = function (tr, n, t) { this.ch[tr].off(n, t || this.ctx.currentTime); };
  Engine.prototype.hit = function (lane, vel, t) { this.ch.drums.hit(lane, t, vel); };
  Engine.prototype.setBend = function (tr, semi) { if (this.ch[tr].setBend) this.ch[tr].setBend(semi); };
  Engine.prototype.currentPattern = function () {
    var s = this.song; return this.loopPattern || s.arrangement[this.arrPos % s.arrangement.length];
  };

  // Lookahead scheduler: schedules steps ~120ms ahead on the audio clock.
  Engine.prototype.play = function () {
    if (this.playing || !this.song) return; var self = this;
    this.resume(); this.playing = true; this.next = this.ctx.currentTime + 0.06;
    this.timer = setInterval(function () { self._tick(); }, 25); this._tick();
  };
  Engine.prototype.pause = function () {
    if (!this.playing) return; this.playing = false; clearInterval(this.timer);
    var ch = this.ch; MELODIC.forEach(function (n) { ch[n].allOff(); });
  };
  Engine.prototype.stop = function () { this.pause(); this.step = 0; this.arrPos = 0; };
  Engine.prototype._tick = function () {
    var s = this.song, c = this.ctx;
    while (this.next < c.currentTime + 0.12) {
      var dur = 15 / s.bpm, pn = this.currentPattern(), pat = s.patterns[pn];
      var t = this.next + (this.step % 2 ? (s.swing || 0) * dur : 0);
      if (pat) this._playStep(pat, this.step, t, dur);
      if (this.onStep) this.onStep(this.step, pn, t);
      this.next += dur;
      if (++this.step >= s.steps) { this.step = 0; if (!this.loopPattern && ++this.arrPos >= s.arrangement.length) this.arrPos = s.loopFrom || 0; }
    }
  };
  Engine.prototype._playStep = function (pat, st, t, dur) {
    var self = this, ch = this.ch;
    if (st === 0) this._sweep(pat.sweep || {}, t, dur * this.song.steps);
    MELODIC.forEach(function (tr) {
      (pat[tr] || []).forEach(function (e) {
        if (e[0] !== st) return;
        var ns = Array.isArray(e[1]) ? e[1] : [e[1]], end = t + e[2] * dur * 0.95;
        ns.forEach(function (n) { ch[tr].on(n, t, e[3] || 0.9); ch[tr].off(n, end); });
      });
    });
    var d = pat.drums || {};
    for (var lane in d) { var x = d[lane][st]; if (x === 'x' || x === 'X') ch.drums.hit(lane, t, x === 'X' ? 1 : 0.6); }
    void self;
  };

  // Ramp a filter across one pattern. A filter swept last pattern returns to its patch value.
  Engine.prototype._sweep = function (sw, t, len) {
    var self = this;
    function ramp(p, r) { p.setValueAtTime(r[0], t); p.exponentialRampToValueAtTime(r[1], t + len); }
    MELODIC.forEach(function (n) {
      var c = self.ch[n], r = sw[n];
      if (r) { ramp(c.filt.frequency, r); c.swept = true; }
      else if (c.swept) { c.filt.frequency.setValueAtTime((c.P && c.P.cut) || 18000, t); c.swept = false; }
    });
    if (sw.master) { ramp(this.filter.frequency, sw.master); this.mSwept = true; }
    else if (this.mSwept) { this.filter.frequency.setValueAtTime((this.song.master || {}).cut || 20000, t); this.mSwept = false; }
  };

  var RetroSynth = { create: function (o) { return new Engine(o); }, ALGS: ALGS, TRACKS: TRACKS, MELODIC: MELODIC, LANES: LANES, mtof: mtof, version: '1.0.0' };
  G.RetroSynth = RetroSynth;
})(typeof window !== 'undefined' ? window : globalThis);
