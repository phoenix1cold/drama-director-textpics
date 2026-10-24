import { TextPicsRuntime } from './runtime.mjs';
/**
 * Drama Director — Text & Pics — Module entry point
 *
 * Owns:
 *   - World setting `textPresets` (array of named text/pic presets)
 *   - The TextPicsPanel ApplicationV2 (panel registered with the hub)
 *
 * Own runtime and socket; no Cinematic or Novella dependency.
 */

import { TextPicsPanel } from './textpics-panel.mjs';

const MODULE_ID = 'drama-director-textpics';
const HUB_ID    = 'drama-director-hub';

function _ensureHub() {
  return game.modules.get(HUB_ID)?.api;
}

Hooks.once('init', () => {
  // ── Storage: text presets (per-world, GM-only) ────────────────────────────
  try {
    game.settings.register(MODULE_ID, 'textPresets', {
      scope: 'world', config: false, type: Array, default: [],
    });
  } catch (e) {
    console.warn('[DD TextPics] failed to register textPresets', e);
  }
  console.log('[DD TextPics] initialized');
});

Hooks.once('setup', () => {
  const hub = _ensureHub();
  if (!hub) {
    console.error('[DD TextPics] hub not available; panel will not appear in sidebar');
    return;
  }
  hub.registerPanel({
    id: 'textpics',
    moduleId: MODULE_ID,
    label: 'DDTEXTPICS.hub.label',
    hint:  'DDTEXTPICS.hub.hint',
    description: 'DDTEXTPICS.hub.desc',
    icon: 'fa-solid fa-layer-group',
    color: '#3ec9e0',
    order: 40,
    open: () => {
      if (game.user?.isGM) new TextPicsPanel().render(true);
    },
  });
});

// ── Convenience global so users can call from macros ────────────────────────
Hooks.once('ready', () => {
  TextPicsRuntime.init();
  game.modules.get(MODULE_ID).api = TextPicsRuntime;
  globalThis.DDTextPics = {
    applyEffect: (...args) => TextPicsRuntime.applyEffect(...args),
    dismissText: (...args) => TextPicsRuntime.dismissText(...args),
    openPanel: () => { if (game.user?.isGM) new TextPicsPanel().render(true); },
    getPresets() {
      try { return game.settings.get(MODULE_ID, 'textPresets') ?? []; }
      catch { return []; }
    },
    async savePresets(arr) {
      try { return await game.settings.set(MODULE_ID, 'textPresets', arr); }
      catch (e) { console.warn('[DD TextPics] save failed', e); }
    },
  };
});
