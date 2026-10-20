// The night sky behind the map : a few dozen twinkling stars and up to
// two meteors from the upper right to the lower left, one every 4 s or so,
// drawn on a canvas 2D with requestAnimationFrame. stop on page hide.
const STARS = 36;
const METEORS = 2;
const PERIOD = 4000;

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 9301 + 49297) % 233280;
    return value / 233280;
  };
}
function makeStars(width, height) {
  const rand = seeded(7);
  return Array.from({ length: STARS }, () => ({
    x: rand() * width,
    y: rand() * height,
    r: 0.5 + rand() * 0.9,
    phase: rand() * Math.PI * 2,
    speed: 0.6 + rand() * 1.2,
  }));
}
// Where meteor i is at time t (ms): it flies for 30% of its period, then
// rests. Returns null while it rests.
function meteorAt(i, t, width, height) {
  const period = PERIOD + i * 1300;
  const phase = ((t + i * 1700) % period) / period;
  if (phase > 0.3) return null;
  const cycle = Math.floor((t + i * 1700) / period);
  const rand = seeded(cycle * 31 + i * 7 + 1);
  const startX = width * (0.55 + rand() * 0.5),
    startY = height * (0.05 + rand() * 0.5);
  const travel = (phase / 0.3) * 330;
  const angle = (146 * Math.PI) / 180;
  return {
    x: startX + Math.cos(angle) * travel,
    y: startY + Math.sin(angle) * travel,
    angle,
    alpha: phase < 0.03 ? phase / 0.03 : 1 - (phase - 0.03) / 0.27,
  };
}
function draw(ctx, stars, t, width, height) {
  ctx.clearRect(0, 0, width, height);
  stars.forEach((star) => {
    const a = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(star.phase + (t / 1000) * star.speed));
    ctx.globalAlpha = a;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    ctx.fill();
  });
  for (let i = 0; i < METEORS; i++) {
    const m = meteorAt(i, t, width, height);
    if (!m) continue;
    const tailX = m.x - Math.cos(m.angle) * 150,
      tailY = m.y - Math.sin(m.angle) * 150;
    const gradient = ctx.createLinearGradient(m.x, m.y, tailX, tailY);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.2, "rgba(190,215,255,0.62)");
    gradient.addColorStop(1, "rgba(140,180,255,0)");
    ctx.globalAlpha = Math.max(0, Math.min(1, m.alpha));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(m.x, m.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
// canvas: the node from createSelectorQuery.fields({ node: true }).
function createSky(canvas, width, height, pixelRatio) {
  const ratio = Math.min(2, pixelRatio || 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const stars = makeStars(width, height);
  let frame = 0,
    running = false,
    skip = false;
  const tick = (time) => {
    if (!running) return;
    // About 30 frames a second is plenty for a backdrop.
    skip = !skip;
    if (!skip) draw(ctx, stars, Number(time) || Date.now(), width, height);
    frame = canvas.requestAnimationFrame(tick);
  };
  return {
    start() {
      if (running) return;
      running = true;
      frame = canvas.requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (frame) canvas.cancelAnimationFrame(frame);
      frame = 0;
    },
    get running() {
      return running;
    },
  };
}
module.exports = { createSky, meteorAt, STARS, METEORS };
