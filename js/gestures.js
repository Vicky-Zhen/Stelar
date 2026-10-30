// ─────────────────────────────────────────────────────────────────────────────
// Hand tracking · 手势追踪 (MediaPipe Hand Landmarker, runs in the browser)
// Produces a smoothed hand cursor and a stable gesture name every video frame:
//   point ☝  pinch 🤏  open ✋  fist ✊  victory ✌  other / none
// Nothing is uploaded: the video stays on the visitor's device.
// ─────────────────────────────────────────────────────────────────────────────
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
export const GESTURE_COLORS = { point: '#8bd6ff', pinch: '#ffd36b', open: '#7dffb0', fist: '#ff8a7a', victory: '#d39bff', other: '#9fb2c4', none: '#9fb2c4' };

const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Pure function, easy to test: landmarks (21 points, normalised image coords) → features.
export function classify(lm, previous = 'none') {
  const palm = Math.max(0.03, d2(lm[0], lm[9]));
  const extended = [[8, 6], [12, 10], [16, 14], [20, 18]].map(([tip, pip]) => d2(lm[tip], lm[0]) > d2(lm[pip], lm[0]) * 1.12);
  const count = extended.filter(Boolean).length;
  const pinch = d2(lm[4], lm[8]) / palm;
  const indexOut = d2(lm[8], lm[0]) > palm * 1.0;
  const openness = [8, 12, 16, 20].reduce((s, i) => s + d2(lm[i], lm[0]), 0) / 4 / palm;
  let g = 'other';
  const pinchLimit = previous === 'pinch' ? 0.48 : 0.34;      // hysteresis: harder to leave a pinch
  if (pinch < pinchLimit && indexOut) g = 'pinch';
  else if (count >= 4) g = 'open';
  else if (extended[0] && !extended[1] && !extended[2] && !extended[3]) g = 'point';
  else if (extended[0] && extended[1] && !extended[2] && !extended[3]) g = 'victory';
  else if (count === 0) g = 'fist';
  return { gesture: g, palm, pinch, openness };
}

export class HandTracker {
  constructor({ video, overlay, onUpdate }) {
    this.video = video; this.overlay = overlay; this.onUpdate = onUpdate;
    this.landmarker = null; this.stream = null; this.running = false;
    this.smooth = null; this.stable = 'none'; this.candidate = 'none'; this.streak = 0; this.lastSeen = 0;
  }
  get active() { return this.running; }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    this.video.srcObject = this.stream; await this.video.play();
    const V = await import(`${VISION}/vision_bundle.mjs`);
    const files = await V.FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const opts = { baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.55, minTrackingConfidence: 0.55 };
    try { this.landmarker = await V.HandLandmarker.createFromOptions(files, opts); }
    catch { opts.baseOptions.delegate = 'CPU'; this.landmarker = await V.HandLandmarker.createFromOptions(files, opts); }
    if (!this.stream) { this.landmarker?.close(); this.landmarker = null; return; } // stopped while loading
    this.running = true; this.loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.landmarker?.close(); this.landmarker = null;
    this.video.srcObject = null; this.smooth = null; this.stable = 'none';
    this.overlay?.getContext('2d').clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.onUpdate({ present: false, gesture: 'none' });
  }

  loop() {
    if (!this.running) return;
    const next = () => this.video.requestVideoFrameCallback ? this.video.requestVideoFrameCallback(() => this.loop()) : requestAnimationFrame(() => this.loop());
    try { this.detect(performance.now()); } catch (e) { console.warn('Hand tracking frame failed', e); }
    next();
  }

  detect(now) {
    if (this.video.readyState < 2) return;
    const lm = this.landmarker.detectForVideo(this.video, now).landmarks?.[0];
    if (!lm) {
      if (now - this.lastSeen > 350) { this.smooth = null; this.stable = 'none'; this.onUpdate({ present: false, gesture: 'none' }); this.draw(null); }
      return;
    }
    this.lastSeen = now;
    // Smooth the landmarks; move faster when the hand moves faster (less lag, less jitter).
    if (!this.smooth) this.smooth = lm.map(p => ({ x: p.x, y: p.y }));
    const speed = d2(lm[9], this.smooth[9]), a = Math.min(0.85, 0.35 + speed * 12);
    this.smooth.forEach((p, i) => { p.x += (lm[i].x - p.x) * a; p.y += (lm[i].y - p.y) * a; });
    const s = this.smooth, f = classify(s, this.stable);
    // A new gesture must hold for 3 frames before it counts (no flicker).
    if (f.gesture === this.candidate) this.streak++; else { this.candidate = f.gesture; this.streak = 1; }
    if (this.streak >= 3 || (f.gesture === 'pinch' && this.streak >= 2)) this.stable = this.candidate;
    // The pointer: midpoint of thumb+index while pinching, palm when open, fingertip otherwise.
    const g = this.stable, src = g === 'pinch' ? { x: (s[4].x + s[8].x) / 2, y: (s[4].y + s[8].y) / 2 } : g === 'open' || g === 'fist' ? s[9] : s[8];
    const clamp01 = v => Math.max(0, Math.min(1, v));
    const cursor = { x: clamp01((1 - src.x - 0.12) / 0.76), y: clamp01((src.y - 0.1) / 0.7) }; // mirrored, comfortable reach box
    this.onUpdate({ present: true, gesture: g, cursor, openness: f.openness, pinch: f.pinch, palmSize: f.palm });
    this.draw(s, g);
  }

  draw(lm, g) {
    const c = this.overlay; if (!c) return;
    const ctx = c.getContext('2d'), w = c.width = c.clientWidth * devicePixelRatio, h = c.height = c.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h); if (!lm) return;
    const col = GESTURE_COLORS[g] || '#fff', X = p => (1 - p.x) * w, Y = p => p.y * h;
    ctx.lineWidth = 2 * devicePixelRatio; ctx.strokeStyle = col; ctx.globalAlpha = 0.85;
    for (const [a, b] of BONES) { ctx.beginPath(); ctx.moveTo(X(lm[a]), Y(lm[a])); ctx.lineTo(X(lm[b]), Y(lm[b])); ctx.stroke(); }
    ctx.fillStyle = col;
    lm.forEach((p, i) => { ctx.beginPath(); ctx.arc(X(p), Y(p), (i % 4 === 0 ? 3.2 : 2) * devicePixelRatio, 0, 7); ctx.fill(); });
    // The reach box that maps to the full screen · 映射到全屏的操作区域
    ctx.globalAlpha = 0.25; ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]); ctx.strokeStyle = '#fff';
    ctx.strokeRect(w * 0.12, h * 0.1, w * 0.76, h * 0.7);
  }
}
