// Generates the 28 Steam achievement icons (14 unlocked + 14 locked) at 64×64,
// matching the Neon Crusade synthwave palette. JPG output goes into
// build/steam_icons/, ready to upload on the Steamworks partner page.
//
// Run with:  npm run icons:steam
//
// Why JPG? Steamworks accepts JPG/PNG, but the partner UI silently converts
// to JPG behind the scenes, so we just hand them what they're going to store.
//
// Why this script and not a one-off? Achievement text, glyphs, or palette
// might tweak before launch — keeping the generator checked in means the
// next regen is `npm run icons:steam` instead of "open a tool and click 28x".

const { createCanvas } = require('@napi-rs/canvas');
const fs   = require('node:fs');
const path = require('node:path');

// ── Achievement spec ─────────────────────────────────────────────────────────
// Single source of truth for the icon side. Keep the `id` aligned with the
// in-game ACHIEVEMENTS array; the Steam API name is then `ACH_<UPPER_ID>`.
//
// `glyph` is the Unicode symbol used in the on-screen unlock toast — reusing
// it on the Steam icon means in-game and Steam icons read the same.
// `color` is the neon accent used for the glyph + glow (full color = unlocked).
const ACHIEVEMENTS = [
  { id: 'first_steps',  glyph: '⏱', color: '#00ffff' }, // Survive 1 min      (cyan / time)
  { id: 'first_skill',  glyph: '✦', color: '#ff66c4' }, // First skill         (magenta / spark)
  { id: 'first_boss',   glyph: '⚔', color: '#ffd84a' }, // First boss          (gold / kill)
  { id: 'wave_3',       glyph: '▲', color: '#00ffff' }, // Wave 3              (cyan / progress)
  { id: 'wave_5',       glyph: '☆', color: '#ffd84a' }, // Wave 5              (gold / star)
  { id: 'veil_walker',  glyph: '♛', color: '#ff0080' }, // 6 bosses / hardcore (hot pink / hardcore)
  { id: 'wave_10',      glyph: '∞', color: '#ffd84a' }, // Wave 10             (gold / endgame)
  { id: 'vanq_100',     glyph: '☠', color: '#ff66c4' }, // 100 kills           (magenta / death)
  { id: 'vanq_500',     glyph: '☠', color: '#ff3355' }, // 500 kills           (deep red / death++)
  { id: 'combo_25',     glyph: '⚡', color: '#ffd84a' }, // 25× combo           (yellow / lightning)
  { id: 'combo_50',     glyph: '⚡', color: '#ff66c4' }, // 50× combo           (magenta / lightning++)
  { id: 'lv_25',        glyph: '◆', color: '#ff66c4' }, // Level 25            (magenta / level)
  { id: 'all_champs',   glyph: '♕', color: '#bda5d0' }, // Tried all 4         (lavender / crown)
  { id: 'survive_15',   glyph: '∞', color: '#00ffff' }, // Survive 15 min      (cyan / eternal)
];

// ── Drawing primitives ──────────────────────────────────────────────────────
// One canvas draws one icon. We do a black background, a soft radial glow
// behind the glyph (unlocked only), then the glyph itself. Locked variant
// drops the color: gray glyph on a barely-different-from-black background,
// no glow — communicates "you haven't done this yet" without changing layout.

const SIZE = 64;
const FONT = 'bold 42px "Apple Symbols", "Arial Unicode MS", "Segoe UI Symbol", sans-serif';

function drawIcon(ctx, glyph, color, locked) {
  // Background — solid black; subtle radial tint when unlocked sells the glow.
  ctx.fillStyle = '#05000c';   // matches body bg in game.html
  ctx.fillRect(0, 0, SIZE, SIZE);

  if (!locked) {
    // Radial glow behind the glyph — gives the icon its synthwave bloom.
    const grad = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 2, SIZE / 2, SIZE / 2, SIZE / 2);
    grad.addColorStop(0, color + 'cc'); // ~80% opacity inner
    grad.addColorStop(0.55, color + '22');
    grad.addColorStop(1,    '#05000c00');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }

  const fg = locked ? '#3b3346' : color;
  if (!locked) {
    ctx.shadowColor = color;
    ctx.shadowBlur  = 14;
  }

  // Some glyphs aren't in the canvas font fallback chain on every machine
  // (e.g. ⏱ STOPWATCH is too new for the bundled symbol fonts). For those
  // we draw shape primitives that visually match the in-game glyph at 64px.
  if (glyph === '⏱') {
    drawStopwatch(ctx, fg);
  } else {
    // Default path — render the Unicode glyph.
    ctx.font         = FONT;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = fg;
    // Tiny vertical nudge — Apple Symbols sits a hair below the optical center.
    ctx.fillText(glyph, SIZE / 2, SIZE / 2 + 2);
  }

  ctx.shadowBlur = 0;
}

// Stopwatch primitive — circle body + crown + single hand pointing 1 o'clock.
// Designed to read as "time" instantly at 64×64 without needing the ⏱ glyph.
function drawStopwatch(ctx, color) {
  const cx = SIZE / 2;
  const cy = SIZE / 2 + 3;        // shift down a hair to leave room for crown
  const r  = 16;                  // body radius
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';

  // Body
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Crown / button on top
  ctx.fillRect(cx - 3, cy - r - 5, 6, 4);

  // Tick at 12 o'clock
  ctx.beginPath();
  ctx.moveTo(cx, cy - r + 1);
  ctx.lineTo(cx, cy - r + 5);
  ctx.stroke();

  // Hand pointing to ~1 o'clock — reads as a running stopwatch
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + 8, cy - 7);
  ctx.stroke();

  // Center pin
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fill();
}

// ── Write the files ─────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'build', 'steam_icons');
fs.mkdirSync(outDir, { recursive: true });

let written = 0;
for (const a of ACHIEVEMENTS) {
  for (const locked of [false, true]) {
    const canvas = createCanvas(SIZE, SIZE);
    const ctx    = canvas.getContext('2d');
    drawIcon(ctx, a.glyph, a.color, locked);
    // Steamworks convention: <name>.jpg = unlocked, <name>_gray.jpg = locked.
    // Match exactly so it's a one-to-one pairing on the partner page.
    const filename = a.id + (locked ? '_gray' : '') + '.jpg';
    const buf = canvas.toBuffer('image/jpeg', 92);
    fs.writeFileSync(path.join(outDir, filename), buf);
    written++;
  }
}

console.log(`Wrote ${written} icons to ${outDir}`);
