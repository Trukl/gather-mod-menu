// Seasonal themes: Halloween, Christmas and Easter looks, picked by hand or by
// the calendar. Gather's interface colors and logo are recolored, every catalog
// object is lightly decorated (autumn leaves and cobwebs, snow and ornaments,
// pastels and Easter eggs) right in the atlases Gather packs them into, and
// effects play over the map. Only this browser sees it.
window.__gatherMods.define("themes", (ctx) => {
  const { GD, readJson, writeJson } = ctx;
  const map = ctx.use("map");
  const SETTINGS_KEY = "gathermodv2:themes";
  const CATALOG_URL = "https://static.gather.town/catalog/";
  const LOGO_URL = "/images/fpo/logos/gather.svg";
  // Gather's color tokens come in blocks of about 200 custom properties.
  const TOKEN_BLOCK_MIN = 100;
  const settings = { theme: "auto", ...readJson(SETTINGS_KEY, {}) };

  const clamp = (v) => Math.min(1, Math.max(0, v));
  function hash(text) {
    let x = 2166136261;
    for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 16777619);
    return x >>> 0;
  }
  function toHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h =
      max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function toRgb(h, s, l) {
    if (!s) return [l * 255, l * 255, l * 255];
    h = (((h % 360) + 360) % 360) / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t) => {
      t = (t + 1) % 1;
      const v =
        t < 1 / 6
          ? p + (q - p) * 6 * t
          : t < 1 / 2
            ? q
            : t < 2 / 3
              ? p + (q - p) * (2 / 3 - t) * 6
              : p;
      return v * 255;
    };
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
  }
  function parseColor(value) {
    const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
    if (hex) {
      const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
      const byte = (i) => parseInt(full.slice(i, i + 2), 16);
      return [byte(0), byte(2), byte(4), full.length === 8 ? byte(6) / 255 : 1];
    }
    const rgb = value.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
    return rgb && [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]];
  }

  // ===================
  // Objects
  // ===================
  // A frame's pixels: tests read `src`, the frame as Gather drew it, painting
  // writes `data`.
  class Pixels {
    constructor(image) {
      this.w = image.width;
      this.h = image.height;
      this.data = image.data;
      this.src = image.data.slice();
    }
    opaque(x, y) {
      return (
        x >= 0 && y >= 0 && x < this.w && y < this.h && this.src[(y * this.w + x) * 4 + 3] > 40
      );
    }
    srcHsl(x, y) {
      const i = (y * this.w + x) * 4;
      return toHsl(this.src[i], this.src[i + 1], this.src[i + 2]);
    }
    // Whether the painted pixel is visible and darker than `lightness`.
    isDark(x, y, lightness) {
      const i = (y * this.w + x) * 4;
      const d = this.data;
      return d[i + 3] > 0 && toHsl(d[i], d[i + 1], d[i + 2])[2] < lightness;
    }
    paint(x, y, [r, g, b, a = 255]) {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      const d = this.data;
      const i = (y * this.w + x) * 4;
      const k = a / 255;
      const under = (d[i + 3] / 255) * (1 - k);
      const out = k + under;
      if (!out) return;
      d[i] = (r * k + d[i] * under) / out;
      d[i + 1] = (g * k + d[i + 1] * under) / out;
      d[i + 2] = (b * k + d[i + 2] * under) / out;
      d[i + 3] = out * 255;
    }
    ellipse(cx, cy, rx, ry, color) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
          if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.paint(x, y, color);
    }
    // fn(h, s, l, x, y) returns the new [h, s, l] of a pixel, or nothing to keep it.
    recolor(fn) {
      const d = this.data;
      for (let y = 0; y < this.h; y++)
        for (let x = 0; x < this.w; x++) {
          const i = (y * this.w + x) * 4;
          if (!d[i + 3]) continue;
          const hsl = fn(...toHsl(d[i], d[i + 1], d[i + 2]), x, y);
          if (hsl) [d[i], d[i + 1], d[i + 2]] = toRgb(...hsl);
        }
    }
    // First and last rows with an opaque pixel.
    rows() {
      let top = this.h;
      let bottom = -1;
      for (let y = 0; y < this.h; y++)
        for (let x = 0; x < this.w; x++)
          if (this.opaque(x, y)) {
            top = Math.min(top, y);
            bottom = y;
            break;
          }
      return { top, bottom };
    }
  }

  const isLeaf = (h, s, l) => h >= 72 && h <= 165 && s > 0.18 && l > 0.1 && l < 0.9;
  const isGlass = (h, s, l) => h >= 165 && h <= 215 && l > 0.6;
  function kindOf({ type = "", family = "", category = "" }) {
    const name = `${type} ${family}`;
    if (/window/i.test(name)) return "glass";
    if (/pond|fishtank|fountain|waterfall|aquarium/i.test(name)) return "water";
    if (
      category === "Nature" ||
      /plant|tree|fern|bonsai|bamboo|palm|planter|pothos|grass|flower|cactus|hosta|ivy|moss/i.test(
        name,
      )
    )
      return "foliage";
    return "thing";
  }

  const WEB = [240, 236, 250, 210];
  const SHADE = [60, 20, 90, 70];
  const STAR = [255, 236, 160];
  // Threads only over the object, from the top corner on the side `seed` picks.
  function cobweb(P, seed) {
    const size = Math.round(Math.min(P.w, P.h) * 0.42);
    if (size < 9) return;
    const dir = seed % 2 ? -1 : 1;
    const cx = dir < 0 ? P.w - 1 : 0;
    const cy = P.rows().top;
    const thread = (angle, r) => {
      const x = Math.round(cx + dir * Math.cos(angle) * r);
      const y = Math.round(cy + Math.sin(angle) * r);
      if (P.opaque(x, y)) P.paint(x, y, WEB);
    };
    for (const t of [0.1, 0.5, 0.9])
      for (let r = 0; r <= size; r += 0.5) thread((t * Math.PI) / 2, r);
    for (const f of [0.35, 0.65, 0.95])
      for (let a = 0; a <= Math.PI / 2; a += 0.015) thread(a, size * f - Math.sin(a * 4) * 0.9);
  }
  function halloween(P, { seed, kind, main }) {
    P.recolor((h, s, l, x, y) => {
      if (kind === "glass" && isGlass(h, s, l)) return [248, 0.45, 0.22 + (0.1 * y) / P.h];
      if (kind === "water" && h >= 160 && h <= 230) return [h + 35, s * 0.9, l * 0.75];
      if (kind === "foliage" && isLeaf(h, s, l))
        return l > 0.55
          ? [32, clamp(s + 0.2), l * 0.95]
          : l > 0.42
            ? [14, clamp(s + 0.15), l * 0.85]
            : [285, clamp(s * 0.8 + 0.1), l * 0.7];
      if ((h >= 300 || h < 15) && s > 0.25 && l > 0.55) return [275, s, l * 0.8];
      if (s < 0.12 && l > 0.82) return [262, 0.2, l * 0.9];
      return [h, s, l < 0.35 ? l * 0.8 : l * 0.94];
    });
    for (let y = 0; y < P.h; y++)
      for (let x = 0; x < P.w; x++) if (P.isDark(x, y, 0.3)) P.paint(x, y, SHADE);
    if (kind === "glass")
      for (let k = 0; k < 4; k++) {
        const x = hash(`${seed}s${k}`) % P.w;
        const y = hash(`${seed}t${k}`) % Math.max(1, Math.round(P.h * 0.6));
        if (P.isDark(x, y, 0.4)) P.paint(x, y, STAR);
      }
    if (main && seed % 10 < 4) cobweb(P, seed);
  }

  const ORNAMENTS = [
    [214, 52, 58],
    [236, 186, 60],
    [70, 110, 210],
  ];
  const GLINT = [255, 255, 255, 220];
  const LIGHT = [255, 236, 150];
  const SNOW = [248, 251, 255];
  const SNOW_EDGE = [214, 228, 242];
  const SNOW_SHADOW = [160, 182, 206, 170];
  function christmas(P, { seed, kind }) {
    if (kind === "foliage") {
      let k = 0;
      for (let y = 2; y < P.h - 2; y++)
        for (let x = 2; x < P.w - 2; x++) {
          if (!P.opaque(x, y) || !isLeaf(...P.srcHsl(x, y))) continue;
          const n = hash(`${seed}:${x}:${y}`) % 1000;
          if (n < 10) {
            P.ellipse(x, y, 1.3, 1.3, ORNAMENTS[k++ % ORNAMENTS.length]);
            P.paint(x - 1, y - 1, GLINT);
          } else if (n < 24) P.paint(x, y, LIGHT);
        }
    }
    if (kind === "glass")
      P.recolor((h, s, l, x, y) =>
        isGlass(h, s, l) ? [205, s * 0.6, clamp(l + 0.25 * (y / P.h) ** 2 + 0.05)] : null,
      );
    // Snow on every edge facing up, a bit uneven.
    const depth = Math.max(2, Math.min(4, Math.round(P.h / 18)));
    for (let x = 0; x < P.w; x++) {
      const n = hash(`${seed}:${x}`) % 7;
      const t = depth + (n === 0 ? 1 : n === 6 ? -1 : 0);
      for (let y = 0; y < P.h; y++) {
        if (!P.opaque(x, y) || P.opaque(x, y - 1)) continue;
        P.paint(x, y - 1, SNOW);
        for (let k = 0; k < t; k++)
          if (P.opaque(x, y + k)) P.paint(x, y + k, k === t - 1 ? SNOW_EDGE : SNOW);
        if (P.opaque(x, y + t)) P.paint(x, y + t, SNOW_SHADOW);
      }
    }
  }

  const PETAL = [255, 255, 255];
  const POLLEN = [255, 214, 80];
  const EGGS = [
    [244, 160, 196],
    [150, 205, 240],
    [250, 220, 120],
    [170, 225, 160],
    [200, 170, 240],
  ];
  const EGG_OUTLINE = [110, 80, 96];
  const EGG_STRIPE = [255, 255, 255, 230];
  const EGG_GLINT = [255, 255, 255, 200];
  function easter(P, { seed, kind, main }) {
    P.recolor((h, s, l) => {
      if (isLeaf(h, s, l)) return [130, clamp(s * 0.65 + 0.1), clamp(l * 0.7 + 0.28)];
      if (s <= 0.12) return [h, s, clamp(l * 0.85 + 0.12)];
      // Wood stays wood, only lighter.
      if (h >= 15 && h < 50) return [h, clamp(s * 0.75 + 0.05), clamp(l * 0.7 + 0.27)];
      const target = h < 60 || h > 300 ? 340 : h < 200 ? 170 : 270;
      const shift = (((target - h + 540) % 360) - 180) * 0.35;
      return [h + shift, clamp(s * 0.75 + 0.1), clamp(l * 0.7 + 0.27)];
    });
    if (kind === "foliage")
      for (let y = 1; y < P.h - 1; y++)
        for (let x = 1; x < P.w - 1; x++) {
          if (!P.opaque(x, y) || !isLeaf(...P.srcHsl(x, y))) continue;
          if (hash(`${seed}f${x}:${y}`) % 1000 > 9) continue;
          for (const [a, b] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ])
            P.paint(x + a, y + b, PETAL);
          P.paint(x, y, POLLEN);
        }
    // Eggs at the foot of plants and of one object type in five.
    if (!main || (kind !== "foliage" && seed % 5)) return;
    const { bottom } = P.rows();
    const n = P.w >= 48 ? 3 : P.w >= 22 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const x = Math.round(((i + 1) * P.w) / (n + 1));
      const y = bottom - 4;
      P.ellipse(x, y, 3.2, 4.2, EGG_OUTLINE);
      P.ellipse(x, y, 2.4, 3.3, EGGS[hash(`${seed}e${i}`) % EGGS.length]);
      for (let dx = -2; dx <= 2; dx++) P.paint(x + dx, y + (dx % 2 ? 0 : 1), EGG_STRIPE);
      P.paint(x - 1, y - 2, EGG_GLINT);
    }
  }

  // ===================
  // Themes
  // ===================
  // Saturation that gives a grey of lightness l the same faint tint.
  const greyTint = (chroma, l) => Math.min(0.4, chroma / Math.max(0.02, 1 - Math.abs(2 * l - 1)));
  const isGatherBlue = (h, s) => s > 0.3 && h >= 200 && h < 250;
  const svgUrl = (w, h, body) =>
    `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)}")`;
  // A square tile of particles drawn by draw(x, y, n), n a random number.
  function scatter(name, tile, count, draw) {
    let body = "";
    for (let i = 0; i < count; i++)
      body += draw(
        6 + (hash(`${name}x${i}`) % (tile - 12)),
        6 + (hash(`${name}y${i}`) % (tile - 12)),
        hash(`${name}n${i}`),
      );
    return svgUrl(tile, tile, body);
  }
  const BAT = svgUrl(
    26,
    14,
    '<g fill="#160d1c"><ellipse cx="13" cy="7.2" rx="2.1" ry="3.2"/><path d="M11.2 5.4 11.6 2l1.2 2.2h.4L14.4 2l.4 3.4z"/><path d="M11.6 6C9 3.2 5 2.2 0 3.6c1.9 1 2.6 2.4 2.4 4 1.4-.6 2.8-.4 3.6.6.8-1 2.4-1.2 3.4-.4.6-.8 1.3-1.2 2.2-1.3z"/><path d="M14.4 6C17 3.2 21 2.2 26 3.6c-1.9 1-2.6 2.4-2.4 4-1.4-.6-2.8-.4-3.6.6-.8-1-2.4-1.2-3.4-.4-.6-.8-1.3-1.2-2.2-1.3z"/></g>',
  );
  const FOG =
    "radial-gradient(40% 70% at 20% 100%, rgba(225,215,245,.3), transparent 70%), radial-gradient(35% 60% at 55% 100%, rgba(225,215,245,.22), transparent 70%), radial-gradient(45% 80% at 85% 100%, rgba(225,215,245,.28), transparent 70%)";
  const flakes = (name, tile, count, size) =>
    scatter(name, tile, count, (x, y, n) => {
      const s = size + (n % 2);
      return `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="#fff" opacity="${0.7 + (n % 4) * 0.1}"/>`;
    });
  const petals = (name, tile, count, size) =>
    scatter(
      name,
      tile,
      count,
      (x, y, n) =>
        `<ellipse cx="${x}" cy="${y}" rx="${size}" ry="${size * 0.55}" fill="${["#f7a8c8", "#fbd0e0", "#fff4f8"][n % 3]}" transform="rotate(${n % 180} ${x} ${y})"/>`,
    );
  const FX_CSS = `
    #gm-theme-fx { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
    #gm-theme-fx > * { position:absolute; }
    #gm-theme-fx .gm-veil { inset:0; }`;

  const monthDay = (d) => (d.getMonth() + 1) * 100 + d.getDate();
  // As a UTC day, to count days without daylight saving time shifts.
  function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const h =
      (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) %
      30;
    const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const n = h + l - 7 * m + 114;
    return Date.UTC(year, Math.floor(n / 31) - 1, (n % 31) + 1);
  }

  const THEMES = {
    halloween: {
      name: "Halloween",
      until: "Nov 1",
      season: (d) => monthDay(d) >= 1015 && monthDay(d) <= 1101,
      ui: (h, s, l) =>
        s < 0.08 ? [270, greyTint(0.05, l), l] : isGatherBlue(h, s) ? [26, s, l] : null,
      logo: {
        colors: ["#f07a1c", "#2b1238"],
        box: [1, 5, 34, 31],
        front:
          '<path d="M12 6.4c-4.6 6.6-4.6 22.6 0 29.2M24 6.4c4.6 6.6 4.6 22.6 0 29.2" fill="none" stroke="#b9500c" stroke-width="1.3" opacity=".6"/><path d="M17.2 6.6c-.5-2.3.3-4.4 2.4-5.6" fill="none" stroke="#4a7324" stroke-width="2.8" stroke-linecap="round"/><path d="M19.6 4.4c1.8-2.6 5.2-3 7.2-1.4-1.8 2-4.8 2.6-7.2 1.4z" fill="#6ea83a"/>',
      },
      objects: halloween,
      fx: {
        html:
          '<div class="gm-veil"></div><div class="gm-fog"></div>' +
          '<div class="gm-flight" style="top:16%;animation-delay:-6s"><i class="gm-bat"></i><i class="gm-bat" style="left:-36px;top:18px;animation-delay:-1.2s"></i></div>' +
          '<div class="gm-flight" style="top:52%;animation-duration:57s;animation-delay:-38s"><i class="gm-bat"></i></div>',
        css: `
          #gm-theme-fx .gm-veil { background:rgba(40,12,66,.26); }
          #gm-theme-fx .gm-fog { left:0; bottom:0; width:200%; height:26%; background:${FOG}; background-size:50% 100%; animation:gm-theme-drift 90s linear infinite; }
          #gm-theme-fx .gm-flight { left:0; width:100%; height:0; animation:gm-theme-fly 40s linear infinite; }
          #gm-theme-fx .gm-bat { position:absolute; left:0; width:26px; height:14px; background:${BAT} center / contain no-repeat; animation:gm-theme-bob 2.2s ease-in-out infinite alternate; }
          @keyframes gm-theme-drift { to { transform:translateX(-50%); } }
          @keyframes gm-theme-fly { from { transform:translateX(-4%); } 40%, to { transform:translateX(104%); } }
          @keyframes gm-theme-bob { from { transform:translateY(-14px); } to { transform:translateY(14px); } }`,
      },
    },
    christmas: {
      name: "Christmas",
      until: "Jan 6",
      season: (d) => monthDay(d) >= 1201 || monthDay(d) <= 106,
      ui: (h, s, l) => (isGatherBlue(h, s) ? [354, s, l] : null),
      logo: {
        colors: ["#c8323b", "#ffffff"],
        front:
          '<path d="M1.3 6.2C1.6 2.6 4.6.6 9 .6h18c4.4 0 7.4 2 7.7 5.6-1.2 1.3-2.4.2-3.4.9-1.1 1.5-2.4.4-3.6.6-1.3.3-1.6 2.2-3 1.9-1.1-.3-1.1-1.6-2.4-1.5-1.4.1-1.7 1.3-3 1.2-1.4-.1-1.6-1.4-3-1.3-1.3.1-1.6 1.9-3 1.8-1.3-.1-1.3-1.6-2.6-1.5-1.3.1-2 1.4-3.4.6z" fill="#fff"/>',
      },
      objects: christmas,
      fx: {
        html: '<div class="gm-veil"></div><div class="gm-fall gm-far"></div><div class="gm-fall"></div>',
        css: `
          #gm-theme-fx .gm-veil { background:rgba(205,225,255,.1); }
          #gm-theme-fx .gm-fall { top:-256px; left:0; right:0; bottom:0; background:${flakes("snow", 256, 9, 3)}; animation:gm-theme-fall 16s linear infinite; }
          #gm-theme-fx .gm-far { top:-192px; background:${flakes("snow-far", 192, 8, 2)}; animation:gm-theme-fall-far 24s linear infinite; }
          @keyframes gm-theme-fall { to { transform:translateY(256px); } }
          @keyframes gm-theme-fall-far { to { transform:translateY(192px); } }`,
      },
    },
    easter: {
      name: "Easter",
      until: "Easter Monday",
      season: (d) => {
        const days =
          (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - easterSunday(d.getFullYear())) /
          864e5;
        return days >= -7 && days <= 1;
      },
      ui: (h, s, l) =>
        s < 0.08 ? [330, greyTint(0.03, l), l] : isGatherBlue(h, s) ? [278, s * 0.8, l] : null,
      logo: {
        colors: ["#a98be0", "#ffffff"],
        box: [2, 8, 32, 28],
        behind:
          '<g fill="#a98be0"><ellipse cx="11.5" cy="8" rx="3.6" ry="7.6" transform="rotate(-14 11.5 8)"/><ellipse cx="24.5" cy="8" rx="3.6" ry="7.6" transform="rotate(14 24.5 8)"/></g><g fill="#f7b6d2"><ellipse cx="11.5" cy="8.4" rx="1.6" ry="5.4" transform="rotate(-14 11.5 8.4)"/><ellipse cx="24.5" cy="8.4" rx="1.6" ry="5.4" transform="rotate(14 24.5 8.4)"/></g>',
      },
      objects: easter,
      fx: {
        html: '<div class="gm-veil"></div><div class="gm-drift gm-far"></div><div class="gm-drift"></div>',
        css: `
          #gm-theme-fx .gm-veil { background:rgba(255,226,240,.08); }
          #gm-theme-fx .gm-drift { top:-256px; left:-256px; right:0; bottom:0; background:${petals("petals", 256, 3, 4)}; animation:gm-theme-petals 34s linear infinite; }
          #gm-theme-fx .gm-far { top:-192px; left:-192px; background:${petals("petals-far", 192, 3, 3)}; animation:gm-theme-petals-far 48s linear infinite; }
          @keyframes gm-theme-petals { to { transform:translate(256px, 256px); } }
          @keyframes gm-theme-petals-far { to { transform:translate(192px, 192px); } }`,
      },
    },
  };

  // ===================
  // Interface: color tokens and logo
  // ===================
  function themedColor(value, ui) {
    const c = parseColor(value.trim());
    const hsl = c && ui(...toHsl(c[0], c[1], c[2]));
    if (!hsl) return null;
    const [r, g, b] = toRgb(...hsl).map(Math.round);
    return c[3] === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${c[3]})`;
  }
  // The token blocks have hashed class names: they're found by their content,
  // then overridden with a stronger selector.
  function tokenCss(ui) {
    const css = [];
    let accent = null;
    for (const sheet of document.styleSheets) {
      let rules;
      // Cross-origin sheets (fonts) can't be read.
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        // The accent of Gather and of this mod, declared on :root.
        const declared =
          rule.selectorText === ":root" && rule.style.getPropertyValue("--theme-color-accent");
        if (declared) accent = themedColor(declared, ui);
        if (!(rule.style?.length >= TOKEN_BLOCK_MIN)) continue;
        let colors = 0;
        const props = [];
        for (const name of rule.style) {
          const value = name.startsWith("--") && rule.style.getPropertyValue(name);
          if (!value || !parseColor(value.trim())) continue;
          colors++;
          const themed = themedColor(value, ui);
          if (themed) props.push(`${name}:${themed}`);
        }
        if (colors >= TOKEN_BLOCK_MIN && props.length)
          css.push(`:is(${rule.selectorText}):is(${rule.selectorText}){${props.join(";")}}`);
      }
    }
    if (accent) css.push(`:root:root{--theme-color-accent:${accent}}`);
    return css.join("\n");
  }
  // Gather's logo in two colors (its dark and light parts), with decorations.
  let logoSource = null;
  async function logoCss({ colors, box = [0, 0, 36, 36], behind = "", front = "" }) {
    logoSource ??= fetch(LOGO_URL).then((r) => r.text());
    const logo = new DOMParser().parseFromString(await logoSource, "image/svg+xml").documentElement;
    const [x, y, width, height] = box;
    const attributes = {
      x,
      y,
      width,
      height,
      preserveAspectRatio: "none",
      filter: "url(#gm-duotone)",
    };
    for (const [k, v] of Object.entries(attributes)) logo.setAttribute(k, v);
    const [dark, light] = colors.map(parseColor);
    const table = (i) => `${dark[i] / 255} ${dark[i] / 255} ${light[i] / 255}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><filter id="gm-duotone" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="table" tableValues="${table(0)}"/><feFuncG type="table" tableValues="${table(1)}"/><feFuncB type="table" tableValues="${table(2)}"/></feComponentTransfer></filter>${behind}${new XMLSerializer().serializeToString(logo)}${front}</svg>`;
    return `img[src$="${LOGO_URL}"]{content:url("data:image/svg+xml,${encodeURIComponent(svg)}")}`;
  }

  // ===================
  // Objects: Gather's atlases
  // ===================
  const textures = () => map.scene().textures;
  // Atlas pages this module repainted, with Gather's image to put back.
  const painted = new Map();
  // Themed pixels by frame name, for the active theme: Gather repacks its
  // atlases as objects come and go.
  let themedFrames = new Map();
  const assetPath = (url) => new URL(url, CATALOG_URL).pathname;
  let variantInfo = new Map();
  function indexVariants() {
    variantInfo = new Map();
    for (const v of GD().Repos.CatalogItemVariant.filter(() => true)) {
      const item = v.catalogItem;
      if (!item) continue;
      const info = { seed: hash(item.type), kind: kindOf(item) };
      if (v.mainRenderable?.imageUrl)
        variantInfo.set(assetPath(v.mainRenderable.imageUrl), { ...info, main: true });
      if (v.foregroundRenderable?.imageUrl)
        variantInfo.set(assetPath(v.foregroundRenderable.imageUrl), { ...info, main: false });
    }
  }
  function frameInfo(name) {
    const path = assetPath(name);
    if (!variantInfo.has(path)) indexVariants();
    return variantInfo.get(path) ?? { seed: hash(path), kind: "thing", main: true };
  }
  function themedFrame(c2d, frame) {
    let pixels = themedFrames.get(frame.name);
    if (!pixels) {
      pixels = c2d.getImageData(frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight);
      THEMES[active].objects(new Pixels(pixels), frameInfo(frame.name));
      themedFrames.set(frame.name, pixels);
    }
    return pixels;
  }
  // Frames are named after the image URL Gather packed.
  function paintTexture(texture) {
    texture.source.forEach((source, index) => {
      const frames = Object.entries(texture.frames)
        .filter(
          ([name, f]) => name.startsWith(CATALOG_URL) && f.sourceIndex === index && !f.rotated,
        )
        .map(([, f]) => f);
      if (!frames.length) return;
      const image = painted.get(source) ?? source.image;
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      const c2d = canvas.getContext("2d", { willReadFrequently: true });
      c2d.drawImage(image, 0, 0);
      for (const f of frames) c2d.putImageData(themedFrame(c2d, f), f.cutX, f.cutY);
      painted.set(source, image);
      source.image = canvas;
      source.isCanvas = true;
      source.update();
    });
  }
  function unpaint() {
    const renderer = map.scene().game.renderer;
    for (const [source, image] of painted) {
      source.image = image;
      source.isCanvas = false;
      renderer.updateCanvasTexture(image, source.glTexture, source.flipY);
    }
    painted.clear();
  }
  const onTextureAdded = (key, texture) => active && paintTexture(texture);
  const onTextureRemoved = (key) => {
    for (const source of painted.keys()) if (source.texture.key === key) painted.delete(source);
  };
  textures().on("addtexture", onTextureAdded);
  textures().on("removetexture", onTextureRemoved);

  // ===================
  // Applying
  // ===================
  const style = document.createElement("style");
  const fx = document.createElement("div");
  fx.id = "gm-theme-fx";
  // First in the map's container, under Gather's labels and bubbles.
  function placeFx() {
    const parent = map.scene().game.canvas.parentElement;
    if (parent.firstElementChild !== fx) parent.prepend(fx);
  }
  const seasonal = () => Object.keys(THEMES).find((id) => THEMES[id].season(new Date())) ?? null;
  const wanted = () =>
    settings.theme === "auto" ? seasonal() : settings.theme === "off" ? null : settings.theme;
  let active = null;
  let applying = 0;
  function apply(id) {
    if (id === active) return;
    const run = ++applying;
    unpaint();
    themedFrames = new Map();
    style.remove();
    fx.remove();
    active = id;
    if (id) {
      const theme = THEMES[id];
      // Read Gather's colors before this module's own rules are back.
      style.textContent = FX_CSS + theme.fx.css + tokenCss(theme.ui);
      document.head.append(style);
      fx.innerHTML = theme.fx.html;
      placeFx();
      for (const key of textures().getTextureKeys()) paintTexture(textures().get(key));
      logoCss(theme.logo).then((css) => {
        if (run === applying) style.textContent += css;
      });
    }
    map.requestRender();
    render();
  }
  ctx.onTick(() => {
    apply(wanted());
    if (active) placeFx();
  });
  ctx.onCleanup(() => {
    textures().off("addtexture", onTextureAdded);
    textures().off("removetexture", onTextureRemoved);
    apply(null);
  });

  // ===================
  // Panel
  // ===================
  const CHOICES = {
    auto: "Auto (calendar)",
    halloween: "Halloween",
    christmas: "Christmas",
    easter: "Easter",
    off: "Off",
  };
  const options = Object.entries(CHOICES)
    .map(([id, label]) => `<option value="${id}">${label}</option>`)
    .join("");
  let root = null;
  function render() {
    if (!root?.isConnected) return;
    root.querySelector("#gm-theme-pick").value = settings.theme;
    root.querySelector("#gm-theme-status").textContent = active
      ? `${THEMES[active].name}${settings.theme === "auto" ? ` until ${THEMES[active].until}` : ""}: interface colors, logo, objects and map effects. Only on your screen.`
      : settings.theme === "auto"
        ? "No season right now. Auto: Halloween from Oct 15, Christmas from Dec 1, Easter the week before Easter Sunday."
        : "Off";
  }
  ctx.section({
    title: "Seasonal themes",
    status: () => active && THEMES[active].name,
    html: `
      <div class="gm-prop"><span>Theme</span><select class="gm-select" id="gm-theme-pick">${options}</select></div>
      <div class="gm-note"><i class="gm-i sm" data-i="paintbrush"></i><span id="gm-theme-status"></span></div>`,
    mount(el) {
      root = el;
      const pick = el.querySelector("#gm-theme-pick");
      pick.addEventListener("change", () => {
        settings.theme = pick.value;
        writeJson(SETTINGS_KEY, settings);
        apply(wanted());
        render();
      });
      render();
    },
  });

  apply(wanted());
});
