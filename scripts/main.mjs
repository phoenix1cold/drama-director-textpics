/**
 * Drama Director — Text & Pics — Module entry point
 *
 * Owns:
 *   - World setting `textPresets` (array of named text/pic presets)
 *   - The TextPicsPanel ApplicationV2 (panel registered with the hub)
 *
 * Effects (rendering text/image overlays) are still produced by the cinematic
 * module's effect engine. The panel calls `game.dramaDirector.applyEffect(...)`
 * if available; without cinematic the panel still opens but the "Apply" button
 * shows a notification.
 */

import { TextPicsPanel } from './textpics-panel.mjs';

const MODULE_ID = 'drama-director-textpics';
const HUB_ID    = 'drama-director-hub';
const CINEMATIC = 'drama-director-cinematic';

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
      // Soft-warn if cinematic is missing
      if (!game.modules.get(CINEMATIC)?.active) {
        ui.notifications?.warn(
          game.i18n.localize('DDTEXTPICS.warn.cinematicMissing')
            || 'Drama Director — Cinematic not enabled. Effects (Apply) will be unavailable.'
        );
      }
      new TextPicsPanel().render(true);
    },
  });
});

// ── Convenience global so users can call from macros ────────────────────────
Hooks.once('ready', () => {
  globalThis.DDTextPics = {
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
