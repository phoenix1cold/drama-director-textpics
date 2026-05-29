/**
 * Drama Director — Text & Pics — Editor (timeline + keyframes).
 *
 * This module is the "monteur" mode for the Text&Pics panel:
 * a small NLE-style timeline where each layer becomes a clip
 * (with `start` / `duration` on a global timebase) and clips can
 * carry keyframes for x, y, scale, rotation, opacity, blur,
 * fontSize and color. The cinematic module's runtime player
 * walks the same keyframe array via rAF.
 *
 * The engine is intentionally self-contained — no external imports
 * beyond Foundry globals — so it can be loaded by both the editor UI
 * (in textpics) and a future preview pane in cinematic without
 * an ES-module cross-import.
 */

export const ANIMATABLE_PROPS = [
  { key: 'x',        type: 'number',  default: 0,    min: -200, max: 200,  step: 1   },
  { key: 'y',        type: 'number',  default: 0,    min: -200, max: 200,  step: 1   },
  { key: 'scale',    type: 'number',  default: 1,    min: 0.05, max: 8,    step: 0.05 },
  { key: 'rotation', type: 'number',  default: 0,    min: -360, max: 360,  step: 1   },
  { key: 'opacity',  type: 'number',  default: 1,    min: 0,    max: 1,    step: 0.01 },
  { key: 'blur',     type: 'number',  default: 0,    min: 0,    max: 30,   step: 0.5 },
  { key: 'fontSize', type: 'number',  default: 1,    min: 0.3,  max: 8,    step: 0.05, textOnly: true },
  { key: 'color',    type: 'color',   default: '#ffffff',                            textOnly: true },
  { key: 'volume',   type: 'number',  default: 1,    min: 0,    max: 1,    step: 0.01, audioOnly: true },
];

/* ────────── Easing functions ────────── */
const EASING = {
  linear:    (t) => t,
  easeIn:    (t) => t * t,
  easeOut:   (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5) ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
};

/** Sample one prop at a given clip-local time t (ms). */
export function sampleKeyframes(keys, prop, t, fallback) {
  if (!Array.isArray(keys) || !keys.length) return fallback;
  // Sort once defensively, callers should keep sorted but cheap insurance.
  const sorted = [...keys].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  // Before first key.
  if (t <= sorted[0].t) return sorted[0][prop] ?? fallback;
  // After last key.
  if (t >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1][prop] ?? fallback;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span <= 0 ? 0 : (t - a.t) / span;
      const ease = EASING[a.easing] ?? EASING.linear;
      const tt = ease(f);
      const va = a[prop] ?? fallback;
      const vb = b[prop] ?? fallback;
      if (typeof va === 'number' && typeof vb === 'number') {
        return va + (vb - va) * tt;
      }
      // Color (hex) lerp.
      if (typeof va === 'string' && va.startsWith('#') && typeof vb === 'string' && vb.startsWith('#')) {
        return _lerpColor(va, vb, tt);
      }
      // Non-numeric / mismatched: step at midpoint.
      return tt < 0.5 ? va : vb;
    }
  }
  return fallback;
}

function _lerpColor(a, b, t) {
  const pa = _parseHex(a), pb = _parseHex(b);
  if (!pa || !pb) return t < 0.5 ? a : b;
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return '#' + [r, g, bl].map(n => n.toString(16).padStart(2, '0')).join('');
}
function _parseHex(s) {
  if (!s || s[0] !== '#') return null;
  const h = s.slice(1);
  if (h.length === 3) {
    return [0, 1, 2].map(i => parseInt(h[i] + h[i], 16));
  }
  if (h.length === 6) {
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }
  return null;
}

/**
 * Convert a single legacy "simple-mode" layer (text or image) into a
 * timeline clip. The clip has no keyframes — its props are just the
 * baseline values, used for rendering when no key is set.
 */
export function layerToClip(type, layer, opts = {}) {
  const totalDuration = opts.duration ?? 4000;
  const baseline = {
    x:        layer.x ?? 0,
    y:        layer.y ?? 0,
    scale:    layer.scale ?? 1,
    rotation: layer.rotation ?? 0,
    opacity:  layer.opacity ?? 1,
    blur:     layer.blur ?? 0,
    fontSize: layer.fontSize ?? 1,
    color:    layer.color ?? '#ffffff',
  };
  return {
    id:        layer._clipId || foundry.utils.randomID(),
    type,                       // 'text' | 'image' | 'video' | 'sequence'
    sourceIdx: layer._layerIdx, // index into the layer array of that type
    start:    0,
    duration: totalDuration,
    baseline,
    keyframes: layer.keyframes ? [...layer.keyframes] : [],
  };
}

/**
 * Build the full clip list from the panel's layer arrays + options.
 * Uses already-attached `_clipId`, `start`, `duration`, `keyframes` if
 * the layer was previously edited in the timeline; otherwise creates a
 * fresh clip with sensible defaults.
 */
export function buildClips({ textLayers, imageLayers, videoLayers, seqLayers, audioLayers, totalDuration }) {
  const clips = [];
  const pushLayers = (arr, type) => {
    arr.forEach((layer, idx) => {
      layer._layerIdx = idx;
      if (!layer._clipId) layer._clipId = foundry.utils.randomID();
      if (typeof layer._clipStart !== 'number')    layer._clipStart    = 0;
      // Clip duration auto-follows the timeline total UNTIL the user
      // manually trims the clip (handled by setting `_userTrimmed = true`
      // on the layer). This gives the "Premiere-default" behaviour: a
      // fresh layer spans the full composition; trimming opts the layer
      // out of auto-follow.
      if (layer._userTrimmed && typeof layer._clipDuration === 'number') {
        // Keep stored value, but clamp to remaining space.
        const remaining = Math.max(100, totalDuration - layer._clipStart);
        if (layer._clipDuration > remaining) layer._clipDuration = remaining;
      } else {
        layer._clipDuration = Math.max(100, totalDuration - (layer._clipStart || 0));
      }
      if (!Array.isArray(layer._keyframes))         layer._keyframes    = [];
      clips.push({
        id:        layer._clipId,
        type,
        sourceIdx: idx,
        start:     layer._clipStart,
        duration:  layer._clipDuration,
        baseline: {
          x:        layer.x ?? 0,
          y:        layer.y ?? 0,
          scale:    layer.scale ?? 1,
          rotation: layer.rotation ?? 0,
          opacity:  layer.opacity ?? 1,
          blur:     layer.blur ?? 0,
          fontSize: layer.fontSize ?? 1,
          color:    layer.color ?? '#ffffff',
          volume:   layer.volume ?? 1,
        },
        keyframes: layer._keyframes.slice(),
      });
    });
  };
  pushLayers(textLayers,  'text');
  pushLayers(imageLayers, 'image');
  pushLayers(videoLayers, 'video');
  pushLayers(seqLayers,   'sequence');
  if (Array.isArray(audioLayers)) pushLayers(audioLayers, 'audio');
  return clips;
}

/**
 * Snapshot of all clip values at a given timeline time (ms).
 * Returns an array of { id, type, sourceIdx, active, values }.
 * `active=false` means the clip hasn't started or has already ended.
 */
export function sampleAt(clips, t) {
  return clips.map(clip => {
    const localT = t - clip.start;
    const active = localT >= 0 && localT <= clip.duration;
    const values = { ...clip.baseline };
    if (active && clip.keyframes && clip.keyframes.length) {
      for (const prop of ANIMATABLE_PROPS) {
        const v = sampleKeyframes(clip.keyframes, prop.key, localT, clip.baseline[prop.key]);
        if (v !== undefined) values[prop.key] = v;
      }
    }
    return { id: clip.id, type: clip.type, sourceIdx: clip.sourceIdx, active, values };
  });
}

/**
 * Apply a snapshot value-object to a DOM element. Used by both the live
 * preview in the editor and the cinematic runtime player.
 *  - x/y are translate %.
 *  - scale, rotation, blur applied via transform / filter.
 *  - opacity directly.
 *  - color/fontSize only relevant for text layers (applied if element has
 *    `data-tp-text` attribute).
 */
export function applyValuesToEl(el, values) {
  if (!el) return;
  const { x = 0, y = 0, scale = 1, rotation = 0, opacity = 1, blur = 0, color, fontSize } = values;
  el.style.transform = `translate(${x}%, ${y}%) scale(${scale}) rotate(${rotation}deg)`;
  el.style.opacity = String(opacity);
  el.style.filter = blur > 0 ? `blur(${blur}px)` : '';
  if (el.hasAttribute('data-tp-text')) {
    if (color)    el.style.color = color;
    if (fontSize) el.style.fontSize = `${fontSize}rem`;
  }
}

/**
 * Resolve an image-layer URL based on its `source` mode.
 * Falls back to the literal URL when no token is selected / no actor.
 */
export function resolveImageSource(layer) {
  const src = layer.source ?? 'url';
  if (src === 'url') return layer.url || '';
  const t = canvas?.tokens?.controlled?.[0];
  if (!t) return layer.url || '';
  if (src === 'tokenPortrait') {
    return t.actor?.img || t.document?.texture?.src || t.actor?.prototypeToken?.texture?.src || layer.url || '';
  }
  if (src === 'tokenImage') {
    return t.document?.texture?.src || t.actor?.prototypeToken?.texture?.src || layer.url || '';
  }
  if (src === 'actorPortrait') {
    return t.actor?.img || layer.url || '';
  }
  return layer.url || '';
}

/** Default keyframe values (used when "Add key at current time" is pressed). */
export function defaultKeyframeFor(clip, t) {
  return {
    id:       foundry.utils.randomID(),
    t,
    easing: 'easeInOut',
    x:        clip.baseline.x,
    y:        clip.baseline.y,
    scale:    clip.baseline.scale,
    rotation: clip.baseline.rotation,
    opacity:  clip.baseline.opacity,
    blur:     clip.baseline.blur,
    fontSize: clip.baseline.fontSize,
    color:    clip.baseline.color,
    volume:   clip.baseline.volume ?? 1,
  };
}
