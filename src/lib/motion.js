// Motion library: path animations as a list of steps from the objects'
// resting place. Pure math, shared by the animation player and its editor.
// Offsets are world pixels, angles degrees, times seconds.
window.__gatherMods.define("motion", () => {
  const TILE_PX = 32;

  // ===================
  // Expressions — users type them and every client evaluates them, so they
  // are parsed here into closures: numbers, t, pi, + - * / ^, parentheses
  // and a few math functions; anything else is refused, nothing runs as code.
  // ===================
  const FUNCTIONS = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    abs: Math.abs,
    sqrt: Math.sqrt,
    exp: Math.exp,
    floor: Math.floor,
    round: Math.round,
    sign: Math.sign,
    min: Math.min,
    max: Math.max,
  };
  const TOKEN_RE = /\s*(\d+(?:\.\d+)?|[a-z]+|[-+*/^(),])/y;
  // A function of t, or null when the expression is not valid.
  function compile(source) {
    if (typeof source !== "string" || source.length > 120) return null;
    const tokens = [];
    TOKEN_RE.lastIndex = 0;
    while (TOKEN_RE.lastIndex < source.length) {
      const m = TOKEN_RE.exec(source);
      if (!m) {
        if (/^\s*$/.test(source.slice(TOKEN_RE.lastIndex))) break;
        return null;
      }
      tokens.push(m[1]);
    }
    let i = 0;
    const peek = () => tokens[i];
    const take = (t) => (tokens[i] === t ? (i++, true) : false);
    function expression() {
      let left = term();
      for (let op = peek(); op === "+" || op === "-"; op = peek()) {
        i++;
        const a = left;
        const b = term();
        left = op === "+" ? (t) => a(t) + b(t) : (t) => a(t) - b(t);
      }
      return left;
    }
    function term() {
      let left = power();
      for (let op = peek(); op === "*" || op === "/"; op = peek()) {
        i++;
        const a = left;
        const b = power();
        left = op === "*" ? (t) => a(t) * b(t) : (t) => a(t) / b(t);
      }
      return left;
    }
    function power() {
      const base = unary();
      if (!take("^")) return base;
      const exponent = power();
      return (t) => Math.pow(base(t), exponent(t));
    }
    function unary() {
      if (take("-")) {
        const a = unary();
        return (t) => -a(t);
      }
      if (take("+")) return unary();
      return primary();
    }
    function primary() {
      const token = tokens[i++];
      if (token === undefined) throw new Error("unexpected end");
      if (/^\d/.test(token)) {
        const value = Number(token);
        return () => value;
      }
      if (token === "t") return (t) => t;
      if (token === "pi") return () => Math.PI;
      if (token === "(") {
        const inner = expression();
        if (!take(")")) throw new Error("missing )");
        return inner;
      }
      const fn = Object.hasOwn(FUNCTIONS, token) ? FUNCTIONS[token] : null;
      if (!fn || !take("(")) throw new Error("unknown " + token);
      const args = [expression()];
      while (take(",")) args.push(expression());
      if (!take(")")) throw new Error("missing )");
      return (t) => fn(...args.map((a) => a(t)));
    }
    try {
      const fn = expression();
      if (i !== tokens.length) return null;
      return (t) => {
        const v = fn(t);
        return Number.isFinite(v) ? v : 0;
      };
    } catch {
      return null;
    }
  }

  // ===================
  // Easings: progress 0..1 to eased progress (overshoot allowed).
  // ===================
  const bounceOut = (t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  };
  const EASINGS = {
    linear: { label: "Linear", fn: (t) => t },
    "ease-in": { label: "Ease in", fn: (t) => t * t * t },
    "ease-out": { label: "Ease out", fn: (t) => 1 - (1 - t) ** 3 },
    "ease-in-out": {
      label: "Ease in-out",
      fn: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
    },
    "sine-in-out": { label: "Smooth (sine)", fn: (t) => (1 - Math.cos(Math.PI * t)) / 2 },
    "back-out": {
      label: "Overshoot",
      fn: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
    },
    "bounce-out": { label: "Bounce", fn: bounceOut },
    "elastic-out": {
      label: "Elastic",
      fn: (t) =>
        t <= 0 || t >= 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
    },
    custom: { label: "Custom f(t)…", fn: null },
  };
  const easingOf = (step) =>
    step.easing === "custom"
      ? (compile(step.easingExpr) ?? EASINGS.linear.fn)
      : (EASINGS[step.easing]?.fn ?? EASINGS.linear.fn);

  const SHAPES = {
    line: "Straight line",
    wave: "Wave",
    arc: "Arc",
    orbit: "Orbit around a point",
    custom: "Custom x(t), y(t)",
  };
  const rotate = (p, degrees) => {
    const a = (degrees * Math.PI) / 180;
    return {
      x: p.x * Math.cos(a) - p.y * Math.sin(a),
      y: p.x * Math.sin(a) + p.y * Math.cos(a),
    };
  };
  const lerp = (a, b, e) => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e });
  // Unit vector across the move: the side waves start on and arcs bulge to.
  function normal(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  }

  // Where a step ends, from where it starts.
  function stepEnd(from, step) {
    if (step.shape !== "orbit") return step.to;
    const c = step.center;
    const r = rotate({ x: from.x - c.x, y: from.y - c.y }, step.direction * 360 * step.turns);
    return { x: c.x + r.x, y: c.y + r.y };
  }
  function positionOf(from, to, step, e, custom) {
    if (step.shape === "orbit") {
      const c = step.center;
      const r = rotate({ x: from.x - c.x, y: from.y - c.y }, step.direction * 360 * step.turns * e);
      return { x: c.x + r.x, y: c.y + r.y };
    }
    const p = lerp(from, to, e);
    if (step.shape === "wave") {
      const n = normal(from, to);
      const w =
        (step.invert ? -1 : 1) * step.amplitude * TILE_PX * Math.sin(2 * Math.PI * step.waves * e);
      return { x: p.x + n.x * w, y: p.y + n.y * w };
    }
    if (step.shape === "arc") {
      const n = normal(from, to);
      const b = 4 * step.bend * TILE_PX * e * (1 - e);
      return { x: p.x + n.x * b, y: p.y + n.y * b };
    }
    if (step.shape === "custom")
      return { x: p.x + custom.x(e) * TILE_PX, y: p.y + custom.y(e) * TILE_PX };
    return p;
  }

  // ===================
  // Playback
  // ===================
  // Prepares an animation: each step's start time, start and end point and
  // rotation, and the length of one pass.
  function build(animation) {
    let from = { x: 0, y: 0 };
    let angle = 0;
    let time = 0;
    const steps = animation.steps.map((step) => {
      const to = stepEnd(from, step);
      const built = {
        step,
        from,
        to,
        angleFrom: angle,
        angleTo: angle + step.rotate,
        start: time,
        duration: step.duration,
        pause: step.pause,
        ease: easingOf(step),
        custom:
          step.shape === "custom"
            ? { x: compile(step.x) ?? (() => 0), y: compile(step.y) ?? (() => 0) }
            : null,
      };
      from = to;
      angle = built.angleTo;
      time += step.duration + step.pause;
      return built;
    });
    return { steps, total: time, end: animation.end };
  }
  // Seconds into one forward pass for a time since the start.
  function passTime(built, t) {
    const { total, end } = built;
    if (total <= 0) return 0;
    if (end === "once") return Math.min(Math.max(t, 0), total);
    if (end === "pingpong") {
      const m = ((t % (2 * total)) + 2 * total) % (2 * total);
      return m < total ? m : 2 * total - m;
    }
    return ((t % total) + total) % total;
  }
  // Offset and rotation from the resting place at time t (seconds).
  function stateAt(built, t) {
    const s = passTime(built, t);
    for (const b of built.steps) {
      if (s < b.start + b.duration) {
        const e = b.ease(Math.min(Math.max((s - b.start) / b.duration, 0), 1));
        const p = positionOf(b.from, b.to, b.step, e, b.custom);
        return { x: p.x, y: p.y, angle: b.angleFrom + (b.angleTo - b.angleFrom) * e };
      }
      if (s < b.start + b.duration + b.pause) return { x: b.to.x, y: b.to.y, angle: b.angleTo };
    }
    const last = built.steps[built.steps.length - 1];
    return last ? { x: last.to.x, y: last.to.y, angle: last.angleTo } : { x: 0, y: 0, angle: 0 };
  }
  // The path of one forward pass, for drawing it.
  function samplePath(built, perStep = 48) {
    const points = [{ x: 0, y: 0 }];
    for (const b of built.steps)
      for (let k = 1; k <= perStep; k++)
        points.push(positionOf(b.from, b.to, b.step, b.ease(k / perStep), b.custom));
    return points;
  }

  // Delay of each object (index in the selection) for a staggered animation.
  function staggerDelays(animation, anchors) {
    if (animation.mode !== "each" || !animation.stagger?.delay) return anchors.map(() => 0);
    const order = anchors.map((_, i) => i);
    const { order: by, delay } = animation.stagger;
    if (by === "left-right")
      order.sort((a, b) => anchors[a].x - anchors[b].x || anchors[a].y - anchors[b].y);
    else if (by === "top-bottom")
      order.sort((a, b) => anchors[a].y - anchors[b].y || anchors[a].x - anchors[b].x);
    else if (by === "random") {
      let seed = [...String(animation.id ?? "")].reduce(
        (h, c) => (h * 31 + c.charCodeAt(0)) | 0,
        7,
      );
      const random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    const delays = anchors.map(() => 0);
    order.forEach((index, rank) => (delays[index] = rank * delay));
    return delays;
  }

  // Center of anchors (world pixels): where a block turns and the path starts.
  const centerOf = (anchors) => ({
    x: anchors.reduce((s, a) => s + a.x, 0) / anchors.length,
    y: anchors.reduce((s, a) => s + a.y, 0) / anchors.length,
  });
  // Offset and rotation at time t of every member of every group. A group is a
  // selected object (`pivot`, its anchor in world pixels) with what sits on it
  // (`anchors`, itself included).
  // Block: everything moves along the path and turns around the selection's
  // center as one piece. Each: every group follows the path from its own
  // place, with its stagger delay, and turns around its own pivot.
  function framesAt(animation, built, groups, t) {
    const pivots = groups.map((g) => g.pivot);
    const center = centerOf(pivots);
    const delays = staggerDelays(animation, pivots);
    const block = animation.mode === "block";
    const shared = block ? stateAt(built, t) : null;
    return groups.map((g, i) => {
      const s = shared ?? stateAt(built, t - delays[i]);
      const pivot = block ? center : g.pivot;
      return g.anchors.map((a) => {
        if (!s.angle) return s;
        const rel = { x: a.x - pivot.x, y: a.y - pivot.y };
        const r = rotate(rel, s.angle);
        return { x: s.x + r.x - rel.x, y: s.y + r.y - rel.y, angle: s.angle };
      });
    });
  }

  // The first animation types, as a path (to edit them in the path editor).
  function fromLegacy(a, center) {
    const base = { name: a.name, type: "path", objects: a.objects, mode: "block" };
    const p = { x: a.point.x - center.x, y: a.point.y - center.y };
    const step = { duration: a.params.period / 2, easing: "sine-in-out", pause: 0, rotate: 0 };
    if (a.type === "orbit")
      return {
        ...base,
        stagger: { delay: 0, order: "selection" },
        end: "loop",
        steps: [
          {
            ...step,
            shape: "orbit",
            easing: "linear",
            duration: a.params.period,
            center: p,
            turns: 1,
            direction: a.params.direction,
          },
        ],
      };
    const shape =
      a.type === "wave"
        ? { shape: "wave", amplitude: a.params.amplitude, waves: a.params.waves, invert: false }
        : { shape: "line" };
    return {
      ...base,
      stagger: { delay: 0, order: "selection" },
      end: "pingpong",
      steps: [{ ...step, ...shape, to: p }],
    };
  }

  return { EASINGS, SHAPES, compile, build, stateAt, samplePath, framesAt, fromLegacy };
});
