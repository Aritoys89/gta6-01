// Port Solano — synthesized audio. Everything is generated with WebAudio:
// engine hum, police siren, punches, crashes, pickups and jingles.
// No audio files, no network. The context is created lazily on the first
// user gesture so the game can also load silently for screenshots.

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.eng = null;      // { osc, gain, filter }
    this.sir = null;      // { osc, gain, lfo }
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.03);
    }
  }

  // --- helpers -------------------------------------------------------------
  tone(freq, dur, { type = 'sine', vol = 0.2, slide = 0, delay = 0 } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  noise(dur, { vol = 0.3, freq = 800, delay = 0 } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter); filter.connect(g); g.connect(this.master);
    src.start(t0);
  }

  // --- continuous voices ---------------------------------------------------
  engine(on, rpm = 0) {
    if (!this.ctx) return;
    if (on && !this.eng) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 420; filter.Q.value = 2;
      const g = this.ctx.createGain();
      g.gain.value = 0.0;
      osc.connect(filter); filter.connect(g); g.connect(this.master);
      osc.start();
      this.eng = { osc, gain: g, filter };
    }
    if (this.eng) {
      const t = this.ctx.currentTime;
      const f = 55 + rpm * 130;
      this.eng.osc.frequency.setTargetAtTime(f, t, 0.06);
      this.eng.filter.frequency.setTargetAtTime(320 + rpm * 900, t, 0.08);
      this.eng.gain.gain.setTargetAtTime(on ? 0.05 + rpm * 0.05 : 0, t, 0.09);
      if (!on) {
        const eng = this.eng; this.eng = null;
        setTimeout(() => { try { eng.osc.stop(); } catch { /* already stopped */ } }, 350);
      }
    }
  }

  siren(on) {
    if (!this.ctx) return;
    if (on && !this.sir) {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 760;
      const lfo = this.ctx.createOscillator();
      lfo.type = 'square'; lfo.frequency.value = 0.85;
      const lfoGain = this.ctx.createGain(); lfoGain.gain.value = 130;
      lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
      const g = this.ctx.createGain(); g.gain.value = 0.0;
      g.gain.setTargetAtTime(0.028, this.ctx.currentTime, 0.2);
      osc.connect(g); g.connect(this.master);
      osc.start(); lfo.start();
      this.sir = { osc, gain: g, lfo };
    }
    if (!on && this.sir) {
      const sir = this.sir; this.sir = null;
      sir.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
      setTimeout(() => { try { sir.osc.stop(); sir.lfo.stop(); } catch { /* done */ } }, 300);
    }
  }

  // --- one shots -----------------------------------------------------------
  punch() { this.noise(0.09, { vol: 0.35, freq: 500 }); this.tone(120, 0.08, { type: 'sine', vol: 0.25, slide: -60 }); }
  hurt() { this.tone(220, 0.12, { type: 'square', vol: 0.12, slide: -90 }); }
  crash(k = 1) { this.noise(0.28, { vol: 0.25 + 0.3 * k, freq: 900 }); this.tone(70, 0.25, { type: 'sine', vol: 0.3 * k, slide: -30 }); }
  door() { this.tone(180, 0.07, { type: 'square', vol: 0.1 }); this.tone(120, 0.09, { type: 'square', vol: 0.1, delay: 0.07 }); }
  pickup() { this.tone(660, 0.09, { type: 'sine', vol: 0.2 }); this.tone(990, 0.14, { type: 'sine', vol: 0.2, delay: 0.08 }); }
  cash() { this.tone(1320, 0.07, { type: 'triangle', vol: 0.22 }); this.tone(1760, 0.12, { type: 'triangle', vol: 0.22, delay: 0.06 }); }
  click() { this.tone(440, 0.05, { type: 'square', vol: 0.08 }); }
  fail() { this.tone(330, 0.18, { type: 'sawtooth', vol: 0.14 }); this.tone(262, 0.2, { type: 'sawtooth', vol: 0.14, delay: 0.16 }); this.tone(196, 0.34, { type: 'sawtooth', vol: 0.14, delay: 0.32 }); }
  bustedJingle() { this.tone(392, 0.16, { type: 'triangle', vol: 0.2 }); this.tone(330, 0.16, { type: 'triangle', vol: 0.2, delay: 0.16 }); this.tone(262, 0.4, { type: 'triangle', vol: 0.22, delay: 0.32 }); }
  missionJingle() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => this.tone(f, 0.16, { type: 'triangle', vol: 0.22, delay: i * 0.11 }));
  }
  fanfare() {
    const seq = [523, 659, 784, 1047, 784, 1047, 1319];
    seq.forEach((f, i) => this.tone(f, 0.22, { type: 'triangle', vol: 0.24, delay: i * 0.13 }));
    this.noise(0.5, { vol: 0.06, freq: 4000, delay: 0.2 });
  }
}
