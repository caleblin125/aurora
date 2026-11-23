/* ------------------------------------------------------------------
   Space-weather model (deliberately simplified but physically ordered).

     solar wind  ->  IMF coupling  ->  magnetospheric energy storage
                 ->  substorm onset ->  particle precipitation

   The renderer never reads raw solar-wind values directly: they are
   reduced to an activity level and a substorm envelope, which modulate
   emission brightness, filament contrast and palette warmth.
   ------------------------------------------------------------------ */
(function () {
  "use strict";
  const Aurora = (window.Aurora = window.Aurora || {});

  const PHASES = ["QUIET", "GROWTH", "EXPANSION", "RECOVERY"];
  const PHASE_IDLE = 0, PHASE_GROWTH = 1, PHASE_EXPANSION = 2, PHASE_RECOVERY = 3;

  class SpaceWeather {
    constructor() {
      this.t = 0;
      this.windSpeed = 430;
      this.density = 5.2;
      this.bz = -2;
      this.kp = 2.5;
      this.coupling = 0.3;
      this.base = 0.24;
      this.activity = 0.3;
      this.env = 0;
      this.surge = 0;
      this.phase = PHASE_IDLE;
      this.phaseT = 0;
      this.duration = 0;
      this.cooldown = 38;
      this.auto = true;
      this.boost = 0;
      this.nextAuto = 42 + Math.random() * 30;
      this._out = { activity: 0.3, surge: 0, speed: 1 };
    }

    trigger() {
      if (this.phase === PHASE_IDLE) {
        this._enter(PHASE_GROWTH, 7 + Math.random() * 5);
        return true;
      }
      if (this.phase === PHASE_GROWTH || this.phase === PHASE_EXPANSION) {
        // Second surge while the substorm is already running.
        this.boost = Math.min(0.5, this.boost + 0.25);
        this.phaseT = Math.min(this.phaseT, 0.4);
        return true;
      }
      if (this.phase === PHASE_RECOVERY) {
        this._enter(PHASE_GROWTH, 5 + Math.random() * 4);
        return true;
      }
      return false;
    }

    _enter(phase, duration) {
      this.phase = phase;
      this.phaseT = 0;
      this.duration = duration;
    }

    _advance(dt) {
      this.phaseT += dt;
      if (this.phaseT < this.duration) return;

      if (this.phase === PHASE_GROWTH) {
        this._enter(PHASE_EXPANSION, 18 + Math.random() * 14);
      } else if (this.phase === PHASE_EXPANSION) {
        this._enter(PHASE_RECOVERY, 22 + Math.random() * 16);
      } else if (this.phase === PHASE_RECOVERY) {
        this._enter(PHASE_IDLE, 0);
        this.cooldown = 22 + Math.random() * 26;
        this.nextAuto = this.t + 45 + Math.random() * 70;
        this.boost = 0;
      }
    }

    update(dt) {
      this.t += dt;
      const t = this.t;

      /* ---------- solar wind ---------- */
      this.windSpeed =
        405 +
        46 * Math.sin(t * 0.0131 + 0.4) +
        24 * Math.sin(t * 0.0297 + 1.9) +
        12 * Math.sin(t * 0.071 + 4.2);
      this.density =
        4.8 +
        1.9 * Math.sin(t * 0.0173 + 2.2) +
        0.8 * Math.sin(t * 0.051 + 0.7);
      this.bz =
        -1.6 +
        2.9 * Math.sin(t * 0.0097 + 0.7) +
        1.55 * Math.sin(t * 0.0233 + 2.4) +
        0.65 * Math.sin(t * 0.061 + 5.1);

      /* Dayside reconnection proxy: southward IMF and high speed couple
         more energy into the magnetosphere. */
      const southward = Math.max(0, -this.bz) / 8;
      const speedTerm = Math.max(0, this.windSpeed - 320) / 260;
      this.coupling = Math.min(1, southward * 0.8 + speedTerm * 0.28);

      /* ---------- substorm cycle ---------- */
      this.cooldown -= dt;
      if (this.phase === PHASE_IDLE && this.auto && this.t > this.nextAuto && this.cooldown <= 0) {
        this._enter(PHASE_GROWTH, 7 + Math.random() * 6);
      }
      this._advance(dt);

      this.boost *= Math.exp(-dt * 0.10);

      let env = 0;
      if (this.phase === PHASE_GROWTH) {
        const p = this.phaseT / Math.max(0.001, this.duration);
        env = 0.28 * p * p;
      } else if (this.phase === PHASE_EXPANSION) {
        const p = this.phaseT / Math.max(0.001, this.duration);
        // Fast onset, then a slowly breathing plateau.
        const attack = Math.min(1, p / 0.14);
        const decay = 1 - Math.max(0, (p - 0.55) / 0.45) * 0.35;
        const breathe = 0.86 + 0.14 * Math.sin(this.phaseT * 1.7) * Math.sin(this.phaseT * 0.63 + 1.1);
        env = attack * decay * breathe;
      } else if (this.phase === PHASE_RECOVERY) {
        const p = Math.min(1, this.phaseT / Math.max(0.001, this.duration));
        env = 0.65 * (1 - p) * (1 - p);
      }
      this.env += (env - this.env) * Math.min(1, dt * 2.2);
      this.surge = this.env * (0.8 + 0.2 * Math.sin(t * 0.9 + 1.3));

      this.base = 0.22 + 0.52 * this.coupling;
      this.activity = Math.min(1, this.base + this.env * 0.66 + this.boost);
      this.kp = Math.min(9, 0.8 + this.activity * 7.4);

      const target = this.base + this.env * 0.62 + this.boost;
      this.activity += (target - this.activity) * 0.08;
    }

    label() {
      return PHASES[this.phase];
    }

    /** Reused view object, read every frame by the renderer/UI. */
    visual(dt) {
      const speed = 0.72 + this.activity * 0.55 + this.env * 0.55;
      const o = this._out;
      o.activity = this.activity;
      o.surge = this.surge;
      o.speed = speed;
      return o;
    }
  }

  Aurora.SpaceWeather = SpaceWeather;
})();
