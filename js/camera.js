/* ------------------------------------------------------------------
   Ground-level camera with damped look controls and a slow cinematic
   drift.  The camera never moves from the origin; only orientation and
   field of view change, which keeps the aurora at a believable scale.
   ------------------------------------------------------------------ */
(function () {
  "use strict";
  const Aurora = (window.Aurora = window.Aurora || {});
  const C = () => Aurora.Config.camera;

  class Camera {
    constructor(canvas) {
      this.canvas = canvas;
      const cfg = C();
      this.baseYaw = cfg.yaw;
      this.basePitch = cfg.pitch;
      this.yaw = cfg.yaw;
      this.pitch = cfg.pitch;
      this.fov = cfg.fov;
      this.targetFov = cfg.fov;
      this.auto = Aurora.Config.defaults.autoCamera;
      this.dragging = false;
      this.pointerId = null;
      this.lastX = 0;
      this.lastY = 0;
      this.swayYaw = 0;
      this.swayPitch = 0;
      this._basis = {
        pos: cfg.position.slice(),
        forward: [0, 0, 1],
        right: [1, 0, 0],
        up: [0, 1, 0],
        tanHalfFov: Math.tan(cfg.fov * 0.5),
        aspect: 1,
      };
      this._bind();
    }

    _bind() {
      const el = this.canvas;
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
        this.dragging = true;
        this.pointerId = e.pointerId;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        el.classList.add("dragging");
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener("pointermove", (e) => {
        if (!this.dragging || e.pointerId !== this.pointerId) return;
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        const sens = (this.fov / Math.max(360, window.innerHeight)) * 1.55;
        this.baseYaw -= dx * sens;
        this.basePitch += dy * sens;
        const cfg = C();
        this.baseYaw = Math.max(-2.3, Math.min(2.3, this.baseYaw));
        this.basePitch = Math.max(cfg.minPitch, Math.min(cfg.maxPitch, this.basePitch));
      });
      const end = (e) => {
        if (e.pointerId !== this.pointerId) return;
        this.dragging = false;
        this.pointerId = null;
        el.classList.remove("dragging");
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("wheel", (e) => {
        e.preventDefault();
        const cfg = C();
        this.targetFov = Math.max(
          cfg.minFov,
          Math.min(cfg.maxFov, this.targetFov * Math.exp(e.deltaY * 0.00085))
        );
      }, { passive: false });
      el.addEventListener("dblclick", () => this.reset());
    }

    setAuto(on) {
      this.auto = on;
    }

    reset() {
      const cfg = C();
      this.baseYaw = cfg.yaw;
      this.basePitch = cfg.pitch;
      this.targetFov = cfg.fov;
      this.fov = cfg.fov;
    }

    update(dt, time) {
      const cfg = C();
      const k = 1 - Math.exp(-dt * 5.0);
      const kSlow = 1 - Math.exp(-dt * 1.2);

      if (this.auto && !this.dragging) {
        this.swayYaw =
          Math.sin(time * 0.0087 + 0.4) * 0.085 +
          Math.sin(time * 0.0037 + 2.1) * 0.045;
        this.swayPitch = Math.sin(time * 0.0113 + 1.2) * 0.014;
      } else {
        this.swayYaw += (0 - this.swayYaw) * kSlow;
        this.swayPitch += (0 - this.swayPitch) * kSlow;
      }

      const targetYaw = this.baseYaw + this.swayYaw;
      const targetPitch = Math.max(
        cfg.minPitch,
        Math.min(cfg.maxPitch, this.basePitch + this.swayPitch)
      );
      this.yaw += (targetYaw - this.yaw) * k;
      this.pitch += (targetPitch - this.pitch) * k;
      this.fov += (this.targetFov - this.fov) * k;
    }

    basis(aspect) {
      const cy = Math.cos(this.yaw);
      const sy = Math.sin(this.yaw);
      const cp = Math.cos(this.pitch);
      const sp = Math.sin(this.pitch);

      // Yaw around +Y, pitch up.  Looking down +Z at yaw = 0.
      const fx = sy * cp;
      const fy = sp;
      const fz = cy * cp;
      const rx = cy;
      const rz = -sy;

      const b = this._basis;
      b.pos = C().position;
      b.forward[0] = fx; b.forward[1] = fy; b.forward[2] = fz;
      b.right[0] = rx; b.right[1] = 0; b.right[2] = rz;
      // up = forward × right
      b.up[0] = fy * rz - fz * 0;
      b.up[1] = fz * rx - fx * rz;
      b.up[2] = fx * 0 - fy * rx;
      b.tanHalfFov = Math.tan(this.fov * 0.5);
      b.aspect = aspect;
      return b;
    }
  }

  Aurora.Camera = Camera;
})();
