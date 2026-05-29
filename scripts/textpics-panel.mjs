/**
 * Drama Director — Text & Pics — Panel (ApplicationV2)
 * Extracted from the original panels.mjs.
 *
 * Storage of named presets is owned by THIS module ('drama-director-textpics').
 * Actual rendering (text/image overlays, ::after grain, video/seq layers)
 * delegates to the cinematic module via game.dramaDirector if present.
 */

import {
  ANIMATABLE_PROPS,
  buildClips,
  sampleAt,
  defaultKeyframeFor,
  resolveImageSource,
} from './editor-engine.mjs';

const MODULE_ID = 'drama-director-textpics';
const CINEMATIC_ID = 'drama-director-cinematic';
const { HandlebarsApplicationMixin } = foundry.applications.api;

// ── Helpers: preset CRUD (settings are owned by THIS module) ────────────────
function _getPresetsFromSettings() {
  try { return game.settings.get(MODULE_ID, 'textPresets') ?? []; }
  catch { return []; }
}
async function _saveTextPreset(name, options) {
  const presets = _getPresetsFromSettings().filter(p => p.name !== name);
  presets.push({ name, options, savedAt: Date.now() });
  try { await game.settings.set(MODULE_ID, 'textPresets', presets); }
  catch (e) { console.warn('[DD TextPics] save preset failed', e); }
  return presets;
}
async function _deleteTextPreset(name) {
  const presets = _getPresetsFromSettings().filter(p => p.name !== name);
  try { await game.settings.set(MODULE_ID, 'textPresets', presets); }
  catch (e) { console.warn('[DD TextPics] delete preset failed', e); }
  return presets;
}

// ── Helpers: bridge to cinematic effect engine (optional) ───────────────────
function _cinematic() {
  if (!game.modules.get(CINEMATIC_ID)?.active) return null;
  return globalThis.game?.dramaDirector ?? null;
}
function _warnNoCinematic() {
  const msg = game.i18n.localize('DDTEXTPICS.warn.cinematicMissing')
    || 'Drama Director — Cinematic is not enabled. Effect cannot render.';
  ui.notifications?.warn(msg);
}

export class TextPicsPanel extends HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'dd-textpics-panel',
    classes: ['drama-director', 'dd-panel'],
    tag: 'div',
    window: { title: 'DRAMADIRECTOR.tabs.textpics', icon: 'fas fa-layer-group', resizable: true },
    position: { width: 1058, height: 680 }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/textpics-panel.hbs` }
  };

  async _prepareContext() {
    return {
      presets: _getPresetsFromSettings() || [],
      users: game.users.map(u => ({ id: u.id, name: u.name, color: u.color })),
    };
  }

  _onRender(context, options) {
    const html = this.element;

    // ── Tab switching ────────────────────────────────────────────────────────
    html.querySelectorAll('.dd-tp-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        html.querySelectorAll('.dd-tp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        html.querySelectorAll('.dd-tp-tab-panel').forEach(p => {
          p.style.display = p.dataset.tabPanel === tab ? 'flex' : 'none';
        });
      });
    });

    // ── State ────────────────────────────────────────────────────────────────
    const _textLayers   = [];
    const _imageLayers  = [];
    const _videoLayers  = [];
    const _seqLayers    = [];
    const _audioLayers  = [];
    const _charState    = { scale: 1, x: 0, y: 0, z: 0 };
    const _charPortrait = { url: '', name: '', enabled: false };

    // ── Helpers ──────────────────────────────────────────────────────────────
    const _makeSlider = ({ label, id, min, max, step, value, onChange }) => {
      const wrap = document.createElement('div');
      wrap.className = 'dd-slider-row';
      const lbl = document.createElement('span');
      lbl.className = 'dd-slider-label'; lbl.textContent = label;
      const range = document.createElement('input');
      range.type = 'range'; range.className = 'dd-slider';
      range.min = min; range.max = max; range.step = step; range.value = value;
      const num = document.createElement('input');
      num.type = 'number'; num.className = 'dd-slider-num dd-input';
      num.min = min; num.max = max; num.step = step; num.value = value;
      if (id) { range.id = id + '-range'; num.id = id; }
      const sync = (v) => {
        const c = Math.min(Number(max), Math.max(Number(min), parseFloat(v) || Number(min)));
        range.value = c; num.value = c; onChange(c);
      };
      range.addEventListener('input',  () => sync(range.value));
      num.addEventListener('change',   () => sync(num.value));
      wrap.append(lbl, range, num);
      return { el: wrap, getValue: () => parseFloat(num.value), setValue: (v) => sync(v) };
    };

    const _makeColorPicker = ({ label, id, value, onChange }) => {
      const wrap = document.createElement('div');
      wrap.className = 'dd-color-row';
      wrap.innerHTML = `
        <span class="dd-slider-label">${label}</span>
        <div class="dd-color-swatch-wrap">
          <input type="color" class="dd-color-input" id="${id}" value="${value ?? '#ffffff'}">
          <span class="dd-color-hex">${value ?? '#ffffff'}</span>
        </div>`;
      const inp = wrap.querySelector('input');
      const hex = wrap.querySelector('.dd-color-hex');
      inp.addEventListener('input', () => { hex.textContent = inp.value; onChange(inp.value); });
      return { el: wrap, getValue: () => inp.value, setValue: (v) => { inp.value = v; hex.textContent = v; } };
    };

    // ── Preview ───────────────────────────────────────────────────────────────
    const _rebuildPreview = () => {
      const stage   = html.querySelector('#dd-preview-stage');
      const emptyEl = html.querySelector('#dd-preview-empty');
      const legend  = html.querySelector('#dd-preview-legend');
      if (!stage) return;
      stage.innerHTML = '';
      if (legend) legend.innerHTML = '';

      const hasContent = _imageLayers.some(l => l.url) || _textLayers.some(l => l.text) || _charPortrait.enabled || _videoLayers.some(l => l.url) || _seqLayers.some(l => l.firstFile);
      if (emptyEl) emptyEl.style.display = hasContent ? 'none' : 'flex';
      if (!hasContent) return;

      // Внутренний стейдж 1920×1080, масштабируется под размер превью-контейнера
      // Это гарантирует что CSS-классы (rem-шрифты, позиции) выглядят идентично реальному рендеру
      const previewContainer = html.querySelector('#dd-textpics-preview');
      const containerW = previewContainer?.clientWidth || 320;
      const stageScale = containerW / 1920;

      const inner = document.createElement('div');
      inner.style.cssText = `position:absolute;top:0;left:0;width:1920px;height:1080px;transform:scale(${stageScale});transform-origin:top left;overflow:hidden;background:transparent;`;
      stage.appendChild(inner);

      // Portrait placeholder
      if (_charPortrait.enabled) {
        const pScale = _charState.scale ?? 1;
        const pX     = _charState.x     ?? 0;
        const pY     = _charState.y     ?? 0;
        const overlay = document.createElement('div');
        overlay.style.cssText = [
          'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
          `transform:translate(${pX}%,${pY}%) scale(${pScale});`,
          'transform-origin:center center;',
          `z-index:${10 + (_charState.z ?? 0)};`,
          'pointer-events:none;',
        ].join('');
        const wrap  = document.createElement('div');
        wrap.className = 'ddp-portrait-wrap';
        const frame = document.createElement('div');
        frame.className = 'ddp-portrait-frame';
        if (_charPortrait.url) {
          const img = document.createElement('img');
          img.className = 'ddp-portrait-img'; img.src = _charPortrait.url;
          img.onerror = () => { img.style.display='none'; frame.classList.add('ddp-portrait-no-img'); };
          frame.appendChild(img);
        } else {
          frame.classList.add('ddp-portrait-placeholder');
          frame.innerHTML = '<i class="fas fa-user" style="font-size:20px;color:#444;"></i>';
        }
        wrap.appendChild(frame);
        if (_charPortrait.name) {
          const n = document.createElement('div');
          n.className = 'ddp-portrait-name'; n.textContent = _charPortrait.name;
          wrap.appendChild(n);
        }
        overlay.appendChild(wrap);
        inner.appendChild(overlay);
        if (legend) {
          const row = document.createElement('div'); row.className = 'ddp-legend-row';
          row.innerHTML = `<span class="ddp-legend-dot" style="background:rgba(255,180,100,.8)"></span><span>${_charPortrait.name || 'Portrait'}</span>`;
          legend.appendChild(row);
        }
      }

      // Image layers — та же структура что в _effectText, с поддержкой source-picker
      _imageLayers.forEach((img, i) => {
        const resolvedUrl = resolveImageSource(img);
        // Preview without any usable URL is still meaningful when source is
        // a token (a "no token selected" placeholder shows the layer's slot).
        const isPlaceholder = !resolvedUrl;
        const imgWrap = document.createElement('div');
        imgWrap.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:translate(${img.x??0}%,${img.y??0}%);transform-origin:center center;z-index:${10+(img.z??0)};opacity:${img.opacity??1};`;
        const scaleWrap = document.createElement('div');
        scaleWrap.style.cssText = `display:inline-flex;transform:scale(${img.scale??1});transform-origin:center center;`;
        if (isPlaceholder) {
          const ph = document.createElement('div');
          ph.style.cssText = 'min-width:200px;min-height:160px;display:flex;align-items:center;justify-content:center;color:#888;border:2px dashed rgba(255,255,255,.15);border-radius:8px;font-size:12px;padding:18px;text-align:center;';
          const srcLabel = img.source && img.source !== 'url' ? game.i18n.localize(`DDTEXTPICS.editor.imageSource.${img.source}`) : 'URL';
          ph.textContent = `[${srcLabel}]`;
          scaleWrap.appendChild(ph);
        } else {
          const imgEl = document.createElement('img');
          imgEl.src = resolvedUrl;
          imgEl.style.cssText = 'max-width:1920px;max-height:1080px;object-fit:contain;display:block;pointer-events:none;';
          imgEl.onerror = () => { imgEl.style.display='none'; imgWrap.style.outline='1px dashed rgba(200,80,80,.4)'; };
          scaleWrap.appendChild(imgEl);
        }
        imgWrap.appendChild(scaleWrap);
        inner.appendChild(imgWrap);
        if (legend) {
          const row = document.createElement('div'); row.className = 'ddp-legend-row';
          const lbl = isPlaceholder
            ? (img.source ? `[${img.source}]` : 'Image ' + (i + 1))
            : (resolvedUrl.split('/').pop() || 'Image ' + (i + 1));
          row.innerHTML = `<span class="ddp-legend-dot" style="background:rgba(100,200,255,.7)"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lbl}</span>`;
          legend.appendChild(row);
        }
      });

      // Video layers — show first-frame placeholder in preview
      _videoLayers.forEach((vid, i) => {
        if (!vid.url) return;
        const vWrap = document.createElement('div');
        vWrap.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:translate(${vid.x??0}%,${vid.y??0}%);z-index:${10+(vid.z??0)};opacity:${vid.opacity??1};`;
        const scaleWrap = document.createElement('div');
        scaleWrap.style.cssText = `display:inline-flex;transform:scale(${vid.scale??1});transform-origin:center center;`;
        const vidEl = document.createElement('video');
        vidEl.src = vid.url; vidEl.muted = true; vidEl.preload = 'metadata';
        vidEl.style.cssText = vid.fullscreen ? 'width:1920px;height:1080px;object-fit:cover;' : 'max-width:1920px;max-height:1080px;object-fit:contain;display:block;pointer-events:none;';
        scaleWrap.appendChild(vidEl); vWrap.appendChild(scaleWrap); inner.appendChild(vWrap);
        if (legend) {
          const row = document.createElement('div'); row.className = 'ddp-legend-row';
          row.innerHTML = `<span class="ddp-legend-dot" style="background:rgba(180,100,255,.7)"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🎬 ${vid.url.split('/').pop()||'Video '+(i+1)}</span>`;
          legend.appendChild(row);
        }
      });

      // Sequence layers — show first-frame placeholder
      _seqLayers.forEach((seq, i) => {
        if (!seq.firstFile) return;
        const sWrap = document.createElement('div');
        sWrap.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:translate(${seq.x??0}%,${seq.y??0}%);z-index:${10+(seq.z??0)};opacity:${seq.opacity??1};`;
        const scaleWrap = document.createElement('div');
        scaleWrap.style.cssText = `display:inline-flex;transform:scale(${seq.scale??1});transform-origin:center center;`;
        const imgEl = document.createElement('img');
        imgEl.src = seq.firstFile;
        imgEl.style.cssText = 'max-width:1920px;max-height:1080px;object-fit:contain;display:block;pointer-events:none;';
        scaleWrap.appendChild(imgEl); sWrap.appendChild(scaleWrap); inner.appendChild(sWrap);
        if (legend) {
          const row = document.createElement('div'); row.className = 'ddp-legend-row';
          row.innerHTML = `<span class="ddp-legend-dot" style="background:rgba(100,255,180,.7)"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🎞 Seq: ${seq.firstFile.split('/').pop()||'Sequence '+(i+1)}</span>`;
          legend.appendChild(row);
        }
      });

      // Text layers — используем реальные CSS-классы dd-dramatic-text style-X
      _textLayers.forEach((layer, i) => {
        if (!layer.text) return;
        const layerStyle = layer.style ?? 'default';
        const posMap = { 'left-block':'pos-left','right-block':'pos-right','bottom':'pos-bottom' };
        const posClass = posMap[layerStyle] ?? 'pos-center';

        const textWrap = document.createElement('div');
        textWrap.className = 'dd-text-layer-wrap';
        textWrap.style.cssText = `
          position:absolute;inset:0;display:flex;
          align-items:${posClass==='pos-bottom'?'flex-end':'center'};
          justify-content:${posClass==='pos-left'?'flex-start':posClass==='pos-right'?'flex-end':'center'};
          transform:translate(${layer.x??0}%,${layer.y??0}%);
          z-index:${20+(layer.z??0)};
        `;
        const scaleWrap = document.createElement('div');
        scaleWrap.style.cssText = `transform:scale(${layer.scale??1});transform-origin:center center;display:inline-block;`;
        if (layer.opacity != null && layer.opacity !== 1) scaleWrap.style.opacity = layer.opacity;

        // Используем реальный CSS-класс — шрифт, размер и стиль будут идентичны реальному рендеру
        const textEl = document.createElement('div');
        textEl.className = `dd-dramatic-text style-${layerStyle}`;
        if (layer.color)       textEl.style.color      = layer.color;
        if (layer.bold)        textEl.style.fontWeight  = 'bold';
        if (layer.italic)      textEl.style.fontStyle   = 'italic';
        if (layer.shadowColor) {
          const sc = layer.shadowColor;
          textEl.style.textShadow = `0 0 10px ${sc},0 0 20px ${sc}`;
        }
        textEl.textContent = layer.text;

        scaleWrap.appendChild(textEl);
        textWrap.appendChild(scaleWrap);
        inner.appendChild(textWrap);
        if (legend) {
          const col = layer.color || '#ffffff';
          const row = document.createElement('div'); row.className = 'ddp-legend-row';
          row.innerHTML = `<span class="ddp-legend-dot" style="background:${col}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px;">${layer.text}</span>`;
          legend.appendChild(row);
        }
      });
    };

    // ── Layer counts ──────────────────────────────────────────────────────────
    const _updateLayerCounts = () => {
      const tc = html.querySelector('#dd-text-layer-count');
      const ic = html.querySelector('#dd-image-layer-count');
      const vc = html.querySelector('#dd-video-layer-count');
      const sc = html.querySelector('#dd-seq-layer-count');
      if (tc) tc.textContent = `${_textLayers.length}/10`;
      if (ic) ic.textContent = `${_imageLayers.length}/10`;
      if (vc) vc.textContent = `${_videoLayers.length}/5`;
      if (sc) sc.textContent = `${_seqLayers.length}/5`;
    };

    // ── Animation / style lists ───────────────────────────────────────────────
    const loc = k => game.i18n.localize(k);
    const _textAnimOptions = [
      { v:'fade',        l: loc('DRAMADIRECTOR.textAnimFade')       },
      { v:'zoom',        l: loc('DRAMADIRECTOR.textAnimZoom')       },
      { v:'zoom-out',    l: loc('DRAMADIRECTOR.zoomOut')            },
      { v:'impact',      l: loc('DRAMADIRECTOR.textAnimImpact')     },
      { v:'shake',       l: loc('DRAMADIRECTOR.textAnimShake')      },
      { v:'slideUp',     l: loc('DRAMADIRECTOR.slideUp')            },
      { v:'slideDown',   l: loc('DRAMADIRECTOR.slideDown')          },
      { v:'slideLeft',   l: loc('DRAMADIRECTOR.charIntroAnimSlideLeft')  },
      { v:'slideRight',  l: loc('DRAMADIRECTOR.charIntroAnimSlideRight') },
      { v:'bounce',      l: loc('DRAMADIRECTOR.bounceAnim')         },
      { v:'flip',        l: loc('DRAMADIRECTOR.flipAnim')           },
      { v:'flipY',       l: loc('DRAMADIRECTOR.tp.animFlipY')       },
      { v:'typewriter',  l: loc('DRAMADIRECTOR.tp.animTypewriter')  },
      { v:'glitch',      l: loc('DRAMADIRECTOR.glitch')             },
      { v:'blur',        l: loc('DRAMADIRECTOR.tp.animBlurIn')      },
      { v:'swipeLeft',   l: loc('DRAMADIRECTOR.tp.animSwipeLeft')   },
      { v:'swipeRight',  l: loc('DRAMADIRECTOR.tp.animSwipeRight')  },
      { v:'rise',        l: loc('DRAMADIRECTOR.tp.animRise')        },
      { v:'drop',        l: loc('DRAMADIRECTOR.tp.animDrop')        },
      { v:'spin',        l: loc('DRAMADIRECTOR.tp.animSpin')        },
    ];
    const _textStyleOptions = [
      { v:'default',     l: loc('DRAMADIRECTOR.textStyleCenter')  },
      { v:'left-block',  l: loc('DRAMADIRECTOR.textStyleLeft')    },
      { v:'right-block', l: loc('DRAMADIRECTOR.textStyleRight')   },
      { v:'bottom',      l: loc('DRAMADIRECTOR.textStyleBottom')  },
      { v:'chapter',     l: loc('DRAMADIRECTOR.textStyleChapter') },
      { v:'horror',      l: loc('DRAMADIRECTOR.textStyleHorror')  },
      { v:'anime',       l: loc('DRAMADIRECTOR.textStyleAnime')   },
    ];
    const _animHtml  = _textAnimOptions.map(o  => `<option value="${o.v}">${o.l}</option>`).join('');
    const _styleHtml = _textStyleOptions.map(o => `<option value="${o.v}">${o.l}</option>`).join('');

    // ── Render text layer row ─────────────────────────────────────────────────
    const _renderTextLayer = (idx) => {
      const layer = _textLayers[idx];
      const row   = document.createElement('div');
      row.className = 'dd-layer-row';

      const hdr = document.createElement('div');
      hdr.className = 'dd-layer-row-header';
      hdr.innerHTML = `
        <span class="dd-layer-index">#${idx+1}</span>
        <span class="dd-layer-type-badge dd-badge-text">T</span>
        <span style="font-size:11px;color:#aaa;flex:1">${loc('DRAMADIRECTOR.tp.textLayerLabel')}</span>
        <label class="dd-checkbox-label dd-inline-check" title="${loc('DRAMADIRECTOR.tp.bold')}" style="margin:0">
          <input type="checkbox" data-field="bold" ${layer.bold?'checked':''}><span style="font-weight:bold;font-size:11px">B</span></label>
        <label class="dd-checkbox-label dd-inline-check" title="${loc('DRAMADIRECTOR.tp.italic')}" style="margin:0">
          <input type="checkbox" data-field="italic" ${layer.italic?'checked':''}><span style="font-style:italic;font-size:11px">I</span></label>
        <button type="button" class="dd-layer-remove-btn" data-action-remove="text-${idx}" title="${loc('DRAMADIRECTOR.layerRemove')}"><i class="fas fa-times"></i></button>`;
      hdr.querySelectorAll('[data-field]').forEach(cb =>
        cb.addEventListener('change', () => { layer[cb.dataset.field] = cb.checked; _rebuildPreview(); }));
      row.appendChild(hdr);

      // ── Token name row ────────────────────────────────────────────────────
      const tokenNameRow = document.createElement('div');
      tokenNameRow.className = 'dd-layer-token-name-row';

      // Helper: populate token dropdown
      const _populateTokenDrop = (sel) => {
        sel.innerHTML = `<option value="">— ${loc('DRAMADIRECTOR.tp.tokenSelectPlaceholder')} —</option>`;
        (canvas?.tokens?.placeables ?? []).forEach(t => {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.name || t.id;
          if (t.id === layer.tokenNameId) opt.selected = true;
          sel.appendChild(opt);
        });
      };

      // Helper: resolve name → write to layer.text and update textarea
      const _resolveTokenName = () => {
        if (!layer.useTokenName) return;
        let name = '';
        if (layer.tokenNameSource === 'selected') {
          name = canvas?.tokens?.controlled?.[0]?.name ?? '';
        } else {
          const t = canvas?.tokens?.placeables?.find(t => t.id === layer.tokenNameId);
          name = t?.name ?? '';
        }
        if (name) { layer.text = name; if (ta) ta.value = name; _rebuildPreview(); }
      };

      // Checkbox
      const utnChk = document.createElement('input');
      utnChk.type = 'checkbox';
      utnChk.id = `dd-tl-utn-${idx}`;
      utnChk.checked = !!layer.useTokenName;
      const utnLabel = document.createElement('label');
      utnLabel.htmlFor = utnChk.id;
      utnLabel.className = 'dd-layer-token-name-lbl';
      utnLabel.innerHTML = `<i class="fas fa-user-tag"></i> ${loc('DRAMADIRECTOR.tp.tokenName')}`;

      // Source toggle: selected / dropdown
      const srcToggle = document.createElement('div');
      srcToggle.className = 'dd-layer-token-src-toggle';
      srcToggle.style.display = layer.useTokenName ? 'flex' : 'none';

      const btnSelected = document.createElement('button');
      btnSelected.type = 'button';
      btnSelected.className = 'dd-steps-interval-btn' + (layer.tokenNameSource === 'selected' ? ' active' : '');
      btnSelected.textContent = loc('DRAMADIRECTOR.tp.tokenSelected');
      btnSelected.title = loc('DRAMADIRECTOR.charIntroUseSelected');

      const btnDrop = document.createElement('button');
      btnDrop.type = 'button';
      btnDrop.className = 'dd-steps-interval-btn' + (layer.tokenNameSource === 'dropdown' ? ' active' : '');
      btnDrop.textContent = loc('DRAMADIRECTOR.tp.tokenPick');
      btnDrop.title = loc('DRAMADIRECTOR.tp.tokenPick');

      const tokenDrop = document.createElement('select');
      tokenDrop.className = 'dd-input';
      tokenDrop.style.cssText = 'margin-top:4px;display:' + (layer.tokenNameSource === 'dropdown' ? 'block' : 'none');
      _populateTokenDrop(tokenDrop);

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'dd-icon-btn';
      refreshBtn.style.cssText = 'margin-top:4px;';
      refreshBtn.title = 'Refresh token list';
      refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
      refreshBtn.style.display = layer.tokenNameSource === 'dropdown' ? 'inline-flex' : 'none';

      btnSelected.addEventListener('click', () => {
        layer.tokenNameSource = 'selected';
        btnSelected.classList.add('active');
        btnDrop.classList.remove('active');
        tokenDrop.style.display = 'none';
        refreshBtn.style.display = 'none';
        _resolveTokenName();
      });
      btnDrop.addEventListener('click', () => {
        layer.tokenNameSource = 'dropdown';
        btnDrop.classList.add('active');
        btnSelected.classList.remove('active');
        tokenDrop.style.display = 'block';
        refreshBtn.style.display = 'inline-flex';
        _populateTokenDrop(tokenDrop);
        _resolveTokenName();
      });
      tokenDrop.addEventListener('change', () => {
        layer.tokenNameId = tokenDrop.value;
        _resolveTokenName();
      });
      refreshBtn.addEventListener('click', () => _populateTokenDrop(tokenDrop));

      srcToggle.append(btnSelected, btnDrop);
      tokenNameRow.append(utnChk, utnLabel, srcToggle, tokenDrop, refreshBtn);

      utnChk.addEventListener('change', () => {
        layer.useTokenName = utnChk.checked;
        srcToggle.style.display = utnChk.checked ? 'flex' : 'none';
        tokenDrop.style.display = (utnChk.checked && layer.tokenNameSource === 'dropdown') ? 'block' : 'none';
        refreshBtn.style.display = (utnChk.checked && layer.tokenNameSource === 'dropdown') ? 'inline-flex' : 'none';
        if (utnChk.checked) _resolveTokenName();
        else _rebuildPreview();
      });
      row.appendChild(tokenNameRow);

      // ── Text input (disabled when useTokenName+selected) ──────────────────
      const ta = document.createElement('textarea');
      ta.className = 'dd-layer-text-input'; ta.placeholder = 'Enter text…'; ta.rows = 2; ta.value = layer.text||'';
      ta.addEventListener('input', () => { layer.text = ta.value; _rebuildPreview(); });
      row.appendChild(ta);

      // Style + Animation
      const controls = document.createElement('div');
      controls.className = 'dd-layer-controls';
      controls.innerHTML = `
        <div><span class="dd-layer-label">${loc('DRAMADIRECTOR.tp.styleLabel')}</span><select class="dd-layer-select" data-field="style">${_styleHtml}</select></div>
        <div><span class="dd-layer-label">${loc('DRAMADIRECTOR.tp.animationLabel')}</span><select class="dd-layer-select" data-field="animation">${_animHtml}</select></div>`;
      controls.querySelector('[data-field="style"]').value     = layer.style     ?? 'default';
      controls.querySelector('[data-field="animation"]').value = layer.animation ?? 'fade';
      controls.querySelectorAll('select').forEach(sel =>
        sel.addEventListener('change', () => { layer[sel.dataset.field] = sel.value; _rebuildPreview(); }));
      row.appendChild(controls);

      // Colors
      const colorRow = document.createElement('div');
      colorRow.className = 'dd-layer-colors';
      colorRow.append(
        _makeColorPicker({ label: loc('DRAMADIRECTOR.tp.colorLabel'),  id:`dd-tl-c-${idx}`,  value: layer.color??'#ffffff',       onChange: v => { layer.color=v;       _rebuildPreview(); } }).el,
        _makeColorPicker({ label: loc('DRAMADIRECTOR.tp.shadowLabel'), id:`dd-tl-s-${idx}`,  value: layer.shadowColor??'#000000', onChange: v => { layer.shadowColor=v; _rebuildPreview(); } }).el,
      );
      row.appendChild(colorRow);

      // Timing
      const timingRow = document.createElement('div');
      timingRow.className = 'dd-layer-timing';
      timingRow.innerHTML = `
        <span class="dd-layer-label" style="white-space:nowrap">${loc('DRAMADIRECTOR.tp.delayLabel')}</span>
        <input type="number" class="dd-input dd-layer-timing-input" data-field="delay" min="0" max="10000" step="100" value="${layer.delay??0}" placeholder="0">
        <span class="dd-layer-label" style="white-space:nowrap">${loc('DRAMADIRECTOR.tp.durationLabel')}</span>
        <input type="number" class="dd-input dd-layer-timing-input" data-field="duration" min="0" max="30000" step="500" value="${layer.duration??''}" placeholder="global">`;
      timingRow.querySelectorAll('[data-field]').forEach(inp =>
        inp.addEventListener('change', () => { layer[inp.dataset.field] = inp.value ? parseInt(inp.value) : undefined; }));
      row.appendChild(timingRow);

      // Sliders
      const slidersWrap = document.createElement('div');
      slidersWrap.className = 'dd-layer-sliders';
      [
        { label: loc('DRAMADIRECTOR.scaleParam'),   id:`dd-tl-sc-${idx}`, min:0.1,  max:5,   step:0.1,  field:'scale',   def:1 },
        { label: loc('DRAMADIRECTOR.xPercent'),     id:`dd-tl-x-${idx}`,  min:-100, max:100, step:1,    field:'x',       def:0 },
        { label: loc('DRAMADIRECTOR.yPercent'),     id:`dd-tl-y-${idx}`,  min:-100, max:100, step:1,    field:'y',       def:0 },
        { label: 'Z',                               id:`dd-tl-z-${idx}`,  min:-20,  max:20,  step:1,    field:'z',       def:0 },
        { label: loc('DRAMADIRECTOR.tp.opacityLabel'), id:`dd-tl-o-${idx}`, min:0, max:1,   step:0.05, field:'opacity', def:1 },
      ].forEach(def => {
        slidersWrap.appendChild(_makeSlider({ ...def, value: layer[def.field]??def.def,
          onChange: v => { layer[def.field]=v; _rebuildPreview(); } }).el);
      });
      row.appendChild(slidersWrap);

      row.querySelector('[data-action-remove]')?.addEventListener('click', () => { _textLayers.splice(idx,1); _rebuildTextLayers(); });
      return row;
    };

    // ── Render image layer row ────────────────────────────────────────────────
    const _renderImageLayer = (idx) => {
      const layer = _imageLayers[idx];
      const row   = document.createElement('div');
      row.className = 'dd-layer-row';

      const hdr = document.createElement('div');
      hdr.className = 'dd-layer-row-header';
      hdr.innerHTML = `
        <span class="dd-layer-index">#${idx+1}</span>
        <span class="dd-layer-type-badge dd-badge-img">I</span>
        <span style="font-size:11px;color:#aaa;flex:1">${loc('DRAMADIRECTOR.tp.imageLayerLabel')} <span style="color:#66eeaa;font-size:10px">·GIF✓</span></span>
        <button type="button" class="dd-layer-remove-btn" data-action-remove="img-${idx}" title="${loc('DRAMADIRECTOR.layerRemove')}"><i class="fas fa-times"></i></button>`;
      row.appendChild(hdr);

      // Source picker (URL / selected-token portrait / selected-token image / actor portrait).
      const srcRow = document.createElement('div');
      srcRow.className = 'dd-layer-src-row';
      const srcLbl = document.createElement('span');
      srcLbl.className = 'dd-layer-label';
      srcLbl.style.cssText = 'min-width:60px;';
      srcLbl.textContent = game.i18n.localize('DDTEXTPICS.editor.imageSource.label');
      const srcSel = document.createElement('select');
      srcSel.className = 'dd-input';
      srcSel.style.cssText = 'flex:1';
      [['url',           'DDTEXTPICS.editor.imageSource.url'],
       ['tokenPortrait', 'DDTEXTPICS.editor.imageSource.tokenPortrait'],
       ['tokenImage',    'DDTEXTPICS.editor.imageSource.tokenImage'],
       ['actorPortrait', 'DDTEXTPICS.editor.imageSource.actorPortrait']].forEach(([v, k]) => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = game.i18n.localize(k);
        if ((layer.source ?? 'url') === v) opt.selected = true;
        srcSel.appendChild(opt);
      });
      srcRow.append(srcLbl, srcSel);
      row.appendChild(srcRow);

      const urlRow = document.createElement('div');
      urlRow.className = 'dd-layer-url-row';
      const urlInp = document.createElement('input');
      urlInp.type='text'; urlInp.className='dd-input'; urlInp.placeholder=loc('DRAMADIRECTOR.layerImage'); urlInp.value=layer.url||'';
      urlInp.addEventListener('input', () => { layer.url=urlInp.value; _rebuildPreview(); });
      const browseBtn = document.createElement('button');
      browseBtn.type='button'; browseBtn.className='dd-icon-btn'; browseBtn.innerHTML='<i class="fas fa-folder-open"></i>';
      browseBtn.addEventListener('click', () => {
        new (foundry.applications.apps.FilePicker.implementation)({ type:'imagevideo', location:'data',
          callback: p => { layer.url=p; urlInp.value=p; _rebuildPreview(); } }).render({ force:true });
      });
      urlRow.append(urlInp, browseBtn);
      row.appendChild(urlRow);

      // Hide the URL row when a token-based source is selected — the URL field
      // is then irrelevant (resolved at apply time from the selected token).
      const _syncUrlVisibility = () => {
        const isUrl = (layer.source ?? 'url') === 'url';
        urlRow.style.display = isUrl ? 'flex' : 'none';
      };
      srcSel.addEventListener('change', () => {
        layer.source = srcSel.value;
        _syncUrlVisibility();
        _rebuildPreview();
      });
      _syncUrlVisibility();

      // Fullscreen checkbox
      const fsRow = document.createElement('label');
      fsRow.className = 'dd-checkbox-label dd-layer-fullscreen-label';
      fsRow.title = game.i18n.localize('DRAMADIRECTOR.imageFullscreenHint');
      const fsCb = document.createElement('input');
      fsCb.type = 'checkbox'; fsCb.checked = !!layer.fullscreen;
      fsCb.addEventListener('change', () => { layer.fullscreen = fsCb.checked; _rebuildPreview(); });
      const fsSpan = document.createElement('span');
      fsSpan.textContent = game.i18n.localize('DRAMADIRECTOR.imageFullscreen');
      fsRow.append(fsCb, fsSpan);
      row.appendChild(fsRow);

      const animRow = document.createElement('div');
      animRow.className = 'dd-layer-controls';
      animRow.innerHTML = `<div class="dd-layer-controls-full"><span class="dd-layer-label">${loc('DRAMADIRECTOR.tp.animationLabel')}</span><select class="dd-layer-select">${_animHtml}</select></div>`;
      const animSel = animRow.querySelector('select');
      animSel.value = layer.animation ?? 'fade';
      animSel.addEventListener('change', () => { layer.animation=animSel.value; });
      row.appendChild(animRow);

      // Timing
      const timingRow = document.createElement('div');
      timingRow.className = 'dd-layer-timing';
      timingRow.innerHTML = `
        <span class="dd-layer-label" style="white-space:nowrap">${loc('DRAMADIRECTOR.tp.delayLabel')}</span>
        <input type="number" class="dd-input dd-layer-timing-input" data-field="delay" min="0" max="10000" step="100" value="${layer.delay??0}" placeholder="0">
        <span class="dd-layer-label" style="white-space:nowrap">${loc('DRAMADIRECTOR.tp.durationLabel')}</span>
        <input type="number" class="dd-input dd-layer-timing-input" data-field="duration" min="0" max="30000" step="500" value="${layer.duration??''}" placeholder="global">`;
      timingRow.querySelectorAll('[data-field]').forEach(inp =>
        inp.addEventListener('change', () => { layer[inp.dataset.field] = inp.value ? parseInt(inp.value) : undefined; }));
      row.appendChild(timingRow);

      // Sliders
      const slidersWrap = document.createElement('div');
      slidersWrap.className = 'dd-layer-sliders';
      [
        { label: loc('DRAMADIRECTOR.scaleParam'),      id:`dd-il-sc-${idx}`, min:0.1,  max:5,   step:0.1,  field:'scale',   def:1 },
        { label: loc('DRAMADIRECTOR.xPercent'),        id:`dd-il-x-${idx}`,  min:-100, max:100, step:1,    field:'x',       def:0 },
        { label: loc('DRAMADIRECTOR.yPercent'),        id:`dd-il-y-${idx}`,  min:-100, max:100, step:1,    field:'y',       def:0 },
        { label: 'Z',                                  id:`dd-il-z-${idx}`,  min:-20,  max:20,  step:1,    field:'z',       def:0 },
        { label: loc('DRAMADIRECTOR.tp.opacityLabel'), id:`dd-il-o-${idx}`,  min:0,    max:1,   step:0.05, field:'opacity', def:1 },
      ].forEach(def => {
        slidersWrap.appendChild(_makeSlider({ ...def, value: layer[def.field]??def.def,
          onChange: v => { layer[def.field]=v; _rebuildPreview(); } }).el);
      });
      row.appendChild(slidersWrap);

      row.querySelector('[data-action-remove]')?.addEventListener('click', () => { _imageLayers.splice(idx,1); _rebuildImageLayers(); });
      return row;
    };

    // ── Rebuild containers ────────────────────────────────────────────────────
    const _rebuildTextLayers = () => {
      const cont = html.querySelector('#dd-text-layers-container');
      if (!cont) return;
      cont.innerHTML = '';
      if (_textLayers.length === 0)
        cont.innerHTML = `<div class="dd-layers-empty">${game.i18n.localize('DRAMADIRECTOR.noLayers')}</div>`;
      else _textLayers.forEach((_, i) => cont.appendChild(_renderTextLayer(i)));
      _updateLayerCounts(); _rebuildPreview();
    };
    const _rebuildImageLayers = () => {
      const cont = html.querySelector('#dd-image-layers-container');
      if (!cont) return;
      cont.innerHTML = '';
      if (_imageLayers.length === 0)
        cont.innerHTML = `<div class="dd-layers-empty">${game.i18n.localize('DRAMADIRECTOR.noLayers')}</div>`;
      else _imageLayers.forEach((_, i) => cont.appendChild(_renderImageLayer(i)));
      _updateLayerCounts(); _rebuildPreview();
    };

    // ── Add buttons ───────────────────────────────────────────────────────────
    html.querySelector('[data-action="add-text-layer"]')?.addEventListener('click', () => {
      if (_textLayers.length >= 10) { ui.notifications?.warn(loc('DRAMADIRECTOR.tp.maxTextLayers')); return; }
      _textLayers.push({ text:'', style:'default', animation:'fade', scale:1, x:0, y:0, z:0, color:'#ffffff', shadowColor:'#000000', opacity:1, bold:false, italic:false, useTokenName:false, tokenNameSource:'selected', tokenNameId:'' });
      _rebuildTextLayers();
    });
    html.querySelector('[data-action="add-image-layer"]')?.addEventListener('click', () => {
      if (_imageLayers.length >= 10) { ui.notifications?.warn(loc('DRAMADIRECTOR.tp.maxImageLayers')); return; }
      _imageLayers.push({ url:'', animation:'fade', scale:1, x:0, y:0, z:0, opacity:1 });
      _rebuildImageLayers();
    });

    // ── Video layer builder ────────────────────────────────────────────────
    const _renderVideoLayer = (idx) => {
      const layer = _videoLayers[idx];
      const row   = document.createElement('div');
      row.className = 'dd-layer-row';

      const hdr = document.createElement('div');
      hdr.className = 'dd-layer-row-header';
      hdr.innerHTML = `
        <span class="dd-layer-index">#${idx+1}</span>
        <span class="dd-layer-type-badge" style="background:rgba(180,100,255,.2);color:#cc88ff;border-color:rgba(180,100,255,.3)">VID</span>
        <span style="font-size:11px;color:#aaa;flex:1">${loc('DRAMADIRECTOR.tp.videoLayerLabel')}</span>
        <label class="dd-checkbox-label dd-inline-check" title="${loc('DRAMADIRECTOR.tp.videoLoop')}" style="margin:0">
          <input type="checkbox" class="dd-vid-loop" ${layer.loop?'checked':''}><span style="font-size:10px">🔁</span></label>
        <label class="dd-checkbox-label dd-inline-check" title="${loc('DRAMADIRECTOR.tp.videoMuted')}" style="margin:0">
          <input type="checkbox" class="dd-vid-muted" ${layer.muted!==false?'checked':''}><span style="font-size:10px">🔇</span></label>
        <label class="dd-checkbox-label dd-inline-check" title="Fullscreen" style="margin:0">
          <input type="checkbox" class="dd-vid-fullscreen" ${layer.fullscreen?'checked':''}><span style="font-size:10px">⛶</span></label>
        <button type="button" class="dd-layer-remove-btn"><i class="fas fa-times"></i></button>`;

      hdr.querySelector('.dd-vid-loop').addEventListener('change', e => { layer.loop=e.target.checked; });
      hdr.querySelector('.dd-vid-muted').addEventListener('change', e => { layer.muted=e.target.checked; });
      hdr.querySelector('.dd-vid-fullscreen').addEventListener('change', e => { layer.fullscreen=e.target.checked; _rebuildPreview(); });
      hdr.querySelector('.dd-layer-remove-btn').addEventListener('click', () => { _videoLayers.splice(idx,1); _rebuildVideoLayers(); });
      row.appendChild(hdr);

      const picker = document.createElement('div');
      picker.className = 'dd-sound-picker'; picker.style.marginBottom='.3rem';
      const urlInp = document.createElement('input');
      urlInp.type='text'; urlInp.className='dd-input'; urlInp.placeholder='Video URL (.webm, .mp4)'; urlInp.value=layer.url||'';
      urlInp.addEventListener('input', () => { layer.url=urlInp.value.trim(); _rebuildPreview(); });
      const browseBtn = document.createElement('button');
      browseBtn.type='button'; browseBtn.className='dd-icon-btn'; browseBtn.innerHTML='<i class="fas fa-folder-open"></i>';
      browseBtn.addEventListener('click', () => {
        new (foundry.applications.apps.FilePicker.implementation)({
          type:'video', location:'data',
          callback: p => { urlInp.value=p; layer.url=p; _rebuildPreview(); }
        }).render({ force:true });
      });
      picker.append(urlInp, browseBtn);
      row.appendChild(picker);

      const sliders = document.createElement('div');
      sliders.className = 'dd-layer-sliders';
      [
        { label:'Scale', min:0.1, max:5,    step:0.1, field:'scale',   def:1 },
        { label:'X %',   min:-100,max:100,  step:1,   field:'x',       def:0 },
        { label:'Y %',   min:-100,max:100,  step:1,   field:'y',       def:0 },
        { label:'Z',     min:-10, max:20,   step:1,   field:'z',       def:0 },
        { label:'Opacity',min:0,  max:1,    step:0.05,field:'opacity', def:1 },
      ].forEach(def => {
        sliders.appendChild(_makeSlider({ ...def, value: layer[def.field]??def.def,
          onChange: v => { layer[def.field]=v; _rebuildPreview(); } }).el);
      });
      row.appendChild(sliders);
      return row;
    };

    const _rebuildVideoLayers = () => {
      const container = html.querySelector('#dd-video-layers-container');
      if (!container) return;
      container.innerHTML = '';
      _videoLayers.forEach((_, i) => container.appendChild(_renderVideoLayer(i)));
      _updateLayerCounts();
      _rebuildPreview();
    };

    html.querySelector('[data-action="add-video-layer"]')?.addEventListener('click', () => {
      if (_videoLayers.length >= 5) { ui.notifications?.warn(loc('DRAMADIRECTOR.tp.maxVideoLayers')); return; }
      _videoLayers.push({ url:'', loop:false, muted:true, fullscreen:false, scale:1, x:0, y:0, z:0, opacity:1 });
      _rebuildVideoLayers();
    });

    // ── Sequence layer builder ─────────────────────────────────────────────
    const _parseSeqPath = (path) => {
      if (!path) return { basePath:'', ext:'', num:0, padLen:1 };
      const ext   = path.match(/\.[^.]+$/)?.[0] ?? '.png';
      const noExt = path.slice(0, path.length - ext.length);
      const numMatch = noExt.match(/(\d+)$/);
      if (!numMatch) return { basePath: noExt, ext, num:0, padLen:1 };
      const numStr = numMatch[1];
      return { basePath: noExt.slice(0, noExt.length - numStr.length), ext, num:parseInt(numStr), padLen:numStr.length };
    };

    const _renderSeqLayer = (idx) => {
      const layer = _seqLayers[idx];
      const row   = document.createElement('div');
      row.className = 'dd-layer-row';

      const hdr = document.createElement('div');
      hdr.className = 'dd-layer-row-header';
      hdr.innerHTML = `
        <span class="dd-layer-index">#${idx+1}</span>
        <span class="dd-layer-type-badge" style="background:rgba(100,255,180,.12);color:#66ffaa;border-color:rgba(100,255,180,.25)">SEQ</span>
        <span style="font-size:11px;color:#aaa;flex:1">${loc('DRAMADIRECTOR.tp.seqLayerLabel')}</span>
        <label class="dd-checkbox-label dd-inline-check" title="Loop" style="margin:0">
          <input type="checkbox" class="dd-seq-loop" ${layer.loop!==false?'checked':''}><span style="font-size:10px">🔁</span></label>
        <button type="button" class="dd-layer-remove-btn"><i class="fas fa-times"></i></button>`;

      hdr.querySelector('.dd-seq-loop').addEventListener('change', e => { layer.loop=e.target.checked; });
      hdr.querySelector('.dd-layer-remove-btn').addEventListener('click', () => { _seqLayers.splice(idx,1); _rebuildSeqLayers(); });
      row.appendChild(hdr);

      // First file picker
      const firstRow = document.createElement('div');
      firstRow.className = 'dd-sound-picker'; firstRow.style.cssText='margin-bottom:.2rem';
      const firstInp = document.createElement('input');
      firstInp.type='text'; firstInp.className='dd-input'; firstInp.placeholder=`${loc('DRAMADIRECTOR.tp.seqFirstFile')} (e.g. fire_0.png)`;
      firstInp.value = layer.firstFile || '';
      const firstBtn = document.createElement('button');
      firstBtn.type='button'; firstBtn.className='dd-icon-btn'; firstBtn.innerHTML='<i class="fas fa-folder-open"></i>';
      firstBtn.addEventListener('click', () => {
        new (foundry.applications.apps.FilePicker.implementation)({
          type:'image', location:'data',
          callback: p => {
            firstInp.value=p; layer.firstFile=p;
            const parsed = _parseSeqPath(p);
            layer.basePath=parsed.basePath; layer.ext=parsed.ext;
            layer.firstNum=parsed.num; layer.padLen=parsed.padLen;
            if (!layer.lastFile) { lastInp.placeholder=`${loc('DRAMADIRECTOR.tp.seqLastFile')} (e.g. fire_128.png)`; }
            _rebuildPreview();
          }
        }).render({ force:true });
      });
      firstRow.append(firstInp, firstBtn);

      // Last file picker
      const lastRow = document.createElement('div');
      lastRow.className = 'dd-sound-picker'; lastRow.style.cssText='margin-bottom:.3rem';
      const lastInp = document.createElement('input');
      lastInp.type='text'; lastInp.className='dd-input'; lastInp.placeholder=`${loc('DRAMADIRECTOR.tp.seqLastFile')} (e.g. fire_128.png)`;
      lastInp.value = layer.lastFile || '';
      const lastBtn = document.createElement('button');
      lastBtn.type='button'; lastBtn.className='dd-icon-btn'; lastBtn.innerHTML='<i class="fas fa-folder-open"></i>';
      lastBtn.addEventListener('click', () => {
        new (foundry.applications.apps.FilePicker.implementation)({
          type:'image', location:'data',
          callback: p => {
            lastInp.value=p; layer.lastFile=p;
            const parsed = _parseSeqPath(p);
            layer.lastNum=parsed.num;
            // Auto-calculate frame count
            const fc = (layer.lastNum - (layer.firstNum??0)) + 1;
            if (fc > 0) frameCountEl.textContent = `${fc} ${loc('DRAMADIRECTOR.tp.seqFrames')}`;
          }
        }).render({ force:true });
      });
      lastRow.append(lastInp, lastBtn);

      firstInp.addEventListener('input', () => {
        layer.firstFile = firstInp.value.trim();
        const p = _parseSeqPath(layer.firstFile);
        layer.basePath=p.basePath; layer.ext=p.ext; layer.firstNum=p.num; layer.padLen=p.padLen;
        _rebuildPreview();
      });
      lastInp.addEventListener('input', () => {
        layer.lastFile = lastInp.value.trim();
        const p = _parseSeqPath(layer.lastFile);
        layer.lastNum = p.num;
        const fc = (layer.lastNum - (layer.firstNum??0)) + 1;
        if (fc > 0) frameCountEl.textContent = `${fc} ${loc('DRAMADIRECTOR.tp.seqFrames')}`;
      });

      row.appendChild(firstRow);
      row.appendChild(lastRow);

      // Frame count display
      const frameCountEl = document.createElement('div');
      frameCountEl.className = 'dd-seq-frame-info';
      const existingFc = layer.firstFile && layer.lastFile ? (layer.lastNum - layer.firstNum + 1) : 0;
      frameCountEl.textContent = existingFc > 0 ? `${existingFc} ${loc('DRAMADIRECTOR.tp.seqFrames')}` : loc('DRAMADIRECTOR.tp.seqPickFiles');
      row.appendChild(frameCountEl);

      // FPS slider
      const fpsSliders = document.createElement('div');
      fpsSliders.className = 'dd-layer-sliders';
      fpsSliders.appendChild(_makeSlider({
        label:'FPS', min:1, max:60, step:1, value: layer.fps??24,
        onChange: v => { layer.fps=v; }
      }).el);
      [
        { label:'Scale', min:0.1, max:5,    step:0.1, field:'scale',   def:1 },
        { label:'X %',   min:-100,max:100,  step:1,   field:'x',       def:0 },
        { label:'Y %',   min:-100,max:100,  step:1,   field:'y',       def:0 },
        { label:'Z',     min:-10, max:20,   step:1,   field:'z',       def:0 },
        { label:'Opacity',min:0,  max:1,    step:0.05,field:'opacity', def:1 },
      ].forEach(def => {
        fpsSliders.appendChild(_makeSlider({ ...def, value: layer[def.field]??def.def,
          onChange: v => { layer[def.field]=v; _rebuildPreview(); } }).el);
      });
      row.appendChild(fpsSliders);
      return row;
    };

    const _rebuildSeqLayers = () => {
      const container = html.querySelector('#dd-seq-layers-container');
      if (!container) return;
      container.innerHTML = '';
      _seqLayers.forEach((_, i) => container.appendChild(_renderSeqLayer(i)));
      _updateLayerCounts();
      _rebuildPreview();
    };

    html.querySelector('[data-action="add-seq-layer"]')?.addEventListener('click', () => {
      if (_seqLayers.length >= 5) { ui.notifications?.warn(loc('DRAMADIRECTOR.tp.maxSeqLayers')); return; }
      _seqLayers.push({ firstFile:'', lastFile:'', basePath:'', ext:'.png', firstNum:0, lastNum:0, padLen:1, fps:24, loop:true, scale:1, x:0, y:0, z:0, opacity:1 });
      _rebuildSeqLayers();
    });

    // ── Preview refresh ───────────────────────────────────────────────────────
    html.querySelector('#dd-preview-refresh')?.addEventListener('click', _rebuildPreview);

    // ── Global duration slider sync ───────────────────────────────────────────
    const durRange = html.querySelector('#dd-text-duration-range');
    const durNum   = html.querySelector('#dd-text-duration');
    durRange?.addEventListener('input',  () => { if (durNum)   durNum.value   = durRange.value; });
    durNum?.addEventListener('change',   () => { if (durRange) durRange.value = durNum.value;   });

    // ── Sound volume sync ─────────────────────────────────────────────────────
    const sndRange = html.querySelector('#dd-snd-vol-range');
    const sndNum   = html.querySelector('#dd-textpic-sound-vol');
    sndRange?.addEventListener('input',  () => { if (sndNum)   sndNum.value   = sndRange.value; });
    sndNum?.addEventListener('change',   () => { if (sndRange) sndRange.value = sndNum.value;   });

    // ── Character intro ───────────────────────────────────────────────────────
    const charIntroCheck = html.querySelector('#dd-char-intro-enabled');
    const charIntroPanel = html.querySelector('#dd-char-intro-panel');
    const tokenSelect    = html.querySelector('#dd-char-intro-token');
    const previewFrame   = html.querySelector('#dd-char-preview-frame');
    const previewImg     = html.querySelector('#dd-char-preview-img');

    const _setPortraitFromToken = (t) => {
      if (!t?.actor) return;
      const img = t.actor.img; const name = t.document?.name || t.actor.name;
      if (img && previewImg && previewFrame) {
        previewImg.style.backgroundImage = `url('${img}')`;
        previewFrame.classList.add('has-portrait');
        const lbl = previewFrame.querySelector('.dd-char-preview-label');
        if (lbl) lbl.textContent = name;
      }
      _charPortrait.url = img||''; _charPortrait.name = name;
      _rebuildPreview();
    };

    const populateTokens = () => {
      if (!tokenSelect) return;
      tokenSelect.innerHTML = '<option value="">— ' + game.i18n.localize('DRAMADIRECTOR.charIntroToken') + ' —</option>';
      (canvas?.tokens?.placeables ?? []).forEach(t => {
        if (!t.actor) return;
        const opt = document.createElement('option');
        opt.value = t.id; opt.textContent = t.document?.name || t.actor.name;
        tokenSelect.appendChild(opt);
      });
    };

    const useSelectedCheck = html.querySelector('#dd-use-selected-token');
    const _lockTokenSelect = () => {
      const use = useSelectedCheck?.checked ?? false;
      if (tokenSelect) { tokenSelect.disabled = use; tokenSelect.style.opacity = use ? '0.4' : ''; }
      if (use) _setPortraitFromToken(canvas?.tokens?.controlled?.[0]);
    };

    charIntroCheck?.addEventListener('change', e => {
      _charPortrait.enabled = e.target.checked;
      charIntroPanel?.classList.toggle('dd-hidden', !e.target.checked);
      if (e.target.checked) { populateTokens(); _rebuildPreview(); }
      else { _charPortrait.url=''; _charPortrait.name=''; _rebuildPreview(); }
    });
    useSelectedCheck?.addEventListener('change', _lockTokenSelect);
    tokenSelect?.addEventListener('change', e => {
      const t = canvas?.tokens?.placeables?.find(tk => tk.id === e.target.value);
      _setPortraitFromToken(t);
    });

    // Portrait sliders
    const charSlidersEl = html.querySelector('#dd-char-sliders');
    if (charSlidersEl) {
      [
        { label:'Scale', id:'dd-portrait-scale', min:0.1, max:5,   step:0.1, field:'scale', def:1 },
        { label:'X %',   id:'dd-portrait-x',     min:-100,max:100, step:1,   field:'x',     def:0 },
        { label:'Y %',   id:'dd-portrait-y',     min:-100,max:100, step:1,   field:'y',     def:0 },
        { label:'Z',     id:'dd-portrait-z',     min:-10, max:20,  step:1,   field:'z',     def:0 },
      ].forEach(def => {
        charSlidersEl.appendChild(_makeSlider({ ...def, value: def.def,
          onChange: v => { _charState[def.field]=v; _rebuildPreview(); } }).el);
      });
    }

    // ── Collect options ───────────────────────────────────────────────────────
    const collectOptions = () => {
      const duration = parseInt(html.querySelector('#dd-text-duration')?.value) || 4000;
      const holdUntilDismissed = html.querySelector('#dd-hold-until-dismissed')?.checked ?? false;
      const charIntro = charIntroCheck?.checked ?? false;
      const useSelectedToken = useSelectedCheck?.checked ?? false;
      const tokenId = useSelectedToken ? '' : (tokenSelect?.value ?? '');
      const soundUrl = html.querySelector('#dd-textpic-sound')?.value?.trim() ?? '';
      const soundVol = parseFloat(html.querySelector('#dd-textpic-sound-vol')?.value ?? '0.7');
      // Collect active screen effects checkboxes
      const screenEffects = [];
      html.querySelectorAll('.dd-textpic-effect-chk:checked').forEach(cb => screenEffects.push(cb.dataset.effect));
      const soundFadeOut = html.querySelector('#dd-sound-fade-out')?.checked ?? false;
      // Resolve image-source for each image layer at click time. Token-backed
      // sources are evaluated NOW (selected token at apply moment) and
      // serialized as plain URLs so the cinematic legacy renderer doesn't
      // need to know about sources. Layers with no usable URL after resolve
      // are dropped (token-only layers when no token is selected → ignored).
      const _resolvedImages = _imageLayers
        .map(l => ({ ...l, url: resolveImageSource(l) || l.url || '' }))
        .filter(l => !!l.url);
      const opts = {
        duration,
        holdUntilDismissed: holdUntilDismissed || undefined,
        textLayers:  _textLayers.filter(l => l.text),
        imageLayers: _resolvedImages,
        videoLayers: _videoLayers.filter(l => l.url),
        seqLayers:   _seqLayers.filter(l => l.firstFile && l.lastFile),
        screenEffects: screenEffects.length ? screenEffects : undefined,
        soundUrl:     soundUrl || undefined,
        soundVol:     soundUrl ? soundVol : undefined,
        soundFadeOut: soundUrl ? soundFadeOut : undefined,
      };
      if (charIntro) {
        opts.charIntro = true;
        opts.charIntroAnim = html.querySelector('#dd-char-intro-anim')?.value ?? 'fade';
        opts.portraitScale = _charState.scale;
        opts.portraitX     = _charState.x;
        opts.portraitY     = _charState.y;
        opts.portraitZ     = _charState.z;
        opts.hidePortraitFrame = html.querySelector('#dd-hide-portrait-frame')?.checked ?? false;
        opts.useSelectedToken  = useSelectedToken;
        if (!useSelectedToken && tokenId) opts.tokenId = tokenId;
      }
      return opts;
    };

    // ── Apply options to panel ────────────────────────────────────────────────
    const applyOptionsToPanel = (opts) => {
      const set    = (sel, val) => { const el = html.querySelector(sel); if (el) el.value = val ?? ''; };
      const setChk = (sel, val) => { const el = html.querySelector(sel); if (el) el.checked = !!val; };
      set('#dd-text-duration', opts.duration ?? 4000);
      if (durRange) durRange.value = opts.duration ?? 4000;
      setChk('#dd-char-intro-enabled', opts.charIntro ?? false);
      _charPortrait.enabled = !!(opts.charIntro);
      if (opts.charIntro) {
        charIntroPanel?.classList.remove('dd-hidden');
        setChk('#dd-use-selected-token', opts.useSelectedToken ?? false);
        _lockTokenSelect(); populateTokens();
        setTimeout(() => {
          if (!opts.useSelectedToken) set('#dd-char-intro-token', opts.tokenId ?? '');
          set('#dd-char-intro-anim', opts.charIntroAnim ?? 'fade');
          setChk('#dd-hide-portrait-frame', opts.hidePortraitFrame ?? false);
          const setNum = (id, val) => { const el=html.querySelector(`#${id}`); if (!el) return; el.value=val; el.dispatchEvent(new Event('change')); };
          setNum('dd-portrait-scale', opts.portraitScale ?? 1);
          setNum('dd-portrait-x',     opts.portraitX     ?? 0);
          setNum('dd-portrait-y',     opts.portraitY     ?? 0);
          setNum('dd-portrait-z',     opts.portraitZ     ?? 0);
          tokenSelect?.dispatchEvent(new Event('change'));
        }, 50);
      } else {
        charIntroPanel?.classList.add('dd-hidden');
        _charPortrait.url=''; _charPortrait.name='';
      }
      _textLayers.length=0;
      (opts.textLayers??[]).forEach(l => _textLayers.push({ color:'#ffffff', shadowColor:'#000000', opacity:1, bold:false, italic:false, useTokenName:false, tokenNameSource:'selected', tokenNameId:'', ...l }));
      _rebuildTextLayers();
      _imageLayers.length=0;
      (opts.imageLayers??[]).forEach(l => _imageLayers.push({ opacity:1, source:'url', ...l }));
      _rebuildImageLayers();
      _videoLayers.length=0;
      (opts.videoLayers??[]).forEach(l => _videoLayers.push({ loop:false, muted:true, scale:1, x:0, y:0, z:0, opacity:1, ...l }));
      _rebuildVideoLayers();
      _seqLayers.length=0;
      (opts.seqLayers??[]).forEach(l => _seqLayers.push({ fps:24, loop:true, scale:1, x:0, y:0, z:0, opacity:1, ...l }));
      _rebuildSeqLayers();
      _audioLayers.length=0;
      (opts.audioLayers??[]).forEach(l => _audioLayers.push({ volume:1, loop:false, ...l }));
      // Restore sound
      const sndInp = html.querySelector('#dd-textpic-sound');
      const sndVol = html.querySelector('#dd-textpic-sound-vol');
      const sndRng = html.querySelector('#dd-snd-vol-range');
      if (sndInp) sndInp.value = opts.soundUrl ?? '';
      if (sndVol) { sndVol.value = opts.soundVol ?? 0.7; }
      if (sndRng) { sndRng.value = opts.soundVol ?? 0.7; }
      const sndFadeChk = html.querySelector('#dd-sound-fade-out');
      if (sndFadeChk) sndFadeChk.checked = !!(opts.soundFadeOut);
      // Restore screen effects checkboxes
      html.querySelectorAll('.dd-textpic-effect-chk').forEach(cb => {
        cb.checked = (opts.screenEffects ?? []).includes(cb.dataset.effect);
      });
      // ── Restore timeline data ────────────────────────────────────────────
      // When the preset was saved from Timeline-mode, opts.timeline.clips
      // carries clip metadata that isn't on the (sanitized) layer objects.
      // Re-hydrate the private editor fields onto each layer so buildClips()
      // recreates the same clip structure (positions, trims, keyframes).
      if (opts.timeline?.clips?.length) {
        if (typeof opts.timeline.total === 'number') {
          tlState.total = opts.timeline.total;
          const tot = html.querySelector('#dd-tl-total');
          if (tot) { tot.value = opts.timeline.total; tot.dataset.userTouched = '1'; }
        }
        const arrByType = (t) => t === 'text'  ? _textLayers
                              : t === 'image' ? _imageLayers
                              : t === 'video' ? _videoLayers
                              : t === 'audio' ? _audioLayers
                              : _seqLayers;
        opts.timeline.clips.forEach(c => {
          const lay = arrByType(c.type)?.[c.sourceIdx];
          if (!lay) return;
          lay._clipId       = c.id ?? lay._clipId ?? foundry.utils.randomID();
          lay._clipStart    = c.start ?? 0;
          lay._clipDuration = c.duration ?? Math.max(100, tlState.total - (c.start ?? 0));
          lay._userTrimmed  = true;          // keep the saved duration on rebuild
          lay._keyframes    = (c.keyframes ?? []).map(k => ({
            id: k.id ?? foundry.utils.randomID(),
            ...k,
          }));
          // Re-apply baseline values to the layer itself (these drive the
          // initial state when no keyframes are present at t=0).
          if (c.baseline) Object.assign(lay, {
            x:        c.baseline.x        ?? lay.x        ?? 0,
            y:        c.baseline.y        ?? lay.y        ?? 0,
            scale:    c.baseline.scale    ?? lay.scale    ?? 1,
            rotation: c.baseline.rotation ?? lay.rotation ?? 0,
            opacity:  c.baseline.opacity  ?? lay.opacity  ?? 1,
            blur:     c.baseline.blur     ?? lay.blur     ?? 0,
            fontSize: c.baseline.fontSize ?? lay.fontSize ?? 1,
            color:    c.baseline.color    ?? lay.color    ?? '#ffffff',
            volume:   c.baseline.volume   ?? lay.volume   ?? 1,
          });
        });
        // Reset playhead + selection so the timeline opens at the start.
        tlState.t = 0;
        tlState.selectedId    = null;
        tlState.selectedKeyId = null;
        // Auto-switch to Timeline mode so the user immediately sees the
        // loaded clips/keyframes (otherwise it'd look like the load did
        // nothing while we're still in Simple view).
        try { _setMode('timeline'); } catch {}
        try { _refreshTimeline(); } catch {}
      }
    };

    // ── User presets ──────────────────────────────────────────────────────────
    const presetSelect = html.querySelector('#dd-preset-select');
    // Timeline-mode presets carry an `options.timeline.clips` array.
    // We use that as the discriminator: 🎬 = animated timeline preset,
    // 🖼 = legacy simple preset. <option> elements don't support real
    // FA icons so emoji glyphs are the cleanest portable solution.
    const _presetGlyph = (p) =>
      (p?.options?.timeline?.clips?.length ? '🎬' : '🖼');
    const refreshPresetDropdown = (presets) => {
      if (!presetSelect) return;
      const cur = presetSelect.value;
      presetSelect.innerHTML = `<option value="">— ${game.i18n.localize('DRAMADIRECTOR.presetLoad')} —</option>`;
      (presets || _getPresetsFromSettings()).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = `${_presetGlyph(p)}  ${p.name}`;
        presetSelect.appendChild(opt);
      });
      if (cur) presetSelect.value = cur;
    };
    html.querySelector('[data-action="preset-save"]')?.addEventListener('click', async () => {
      const name = html.querySelector('#dd-preset-name')?.value?.trim(); if (!name) return;
      const presets = await _saveTextPreset(name, collectOptions());
      refreshPresetDropdown(presets); if (presetSelect) presetSelect.value = name;
    });
    html.querySelector('[data-action="preset-load"]')?.addEventListener('click', () => {
      const name = presetSelect?.value; if (!name) return;
      const preset = _getPresetsFromSettings().find(p => p.name === name);
      if (!preset) return;
      applyOptionsToPanel(preset.options);
      ui.notifications?.info(game.i18n.format('DRAMADIRECTOR.presetLoaded', { name }));
    });
    html.querySelector('[data-action="preset-delete"]')?.addEventListener('click', async () => {
      const name = presetSelect?.value; if (!name) return;
      refreshPresetDropdown(await _deleteTextPreset(name));
    });

    // ── Action buttons (bottom bar) ───────────────────────────────────────────
    html.querySelector('[data-action="show-text"]')?.addEventListener('click', () => {
      const opts = collectOptions();
      const targetUser = html.querySelector('#dd-target-user')?.value || null;
      if (opts.textLayers?.length || opts.imageLayers?.length || opts.charIntro) {
        const soundUrl = html.querySelector('#dd-textpic-sound')?.value?.trim();
        const soundVol = parseFloat(sndNum?.value ?? '0.7');
        if (soundUrl) _cinematic()?.playCustomSound?.(soundUrl, { volume: soundVol });
        const dd = _cinematic();
        if (dd) dd.applyEffect('text', opts, targetUser);
        else _warnNoCinematic();
      }
    });
    html.querySelector('[data-action="copy-macro"]')?.addEventListener('click', () => {
      const opts = collectOptions();
      const targetUser = html.querySelector('#dd-target-user')?.value || null;
      navigator.clipboard?.writeText(_cinematic()?.generateTextMacro?.(opts, targetUser) ?? '')
        .then(() => ui.notifications?.info(game.i18n.localize('DRAMADIRECTOR.macroCopied')));
    });
    html.querySelector('[data-action="dismiss-text"]')?.addEventListener('click', () => {
      const targetUser = html.querySelector('#dd-target-user')?.value || null;
      _cinematic()?.dismissText?.(targetUser);
    });
    html.querySelector('[data-action="clear"]')?.addEventListener('click', () => {
      _cinematic()?.clearEffects?.(html.querySelector('#dd-target-user')?.value || null);
    });
    html.querySelector('[data-action="browse-textpic-sound"]')?.addEventListener('click', () => {
      new (foundry.applications.apps.FilePicker.implementation)({ type:'audio', location:'data',
        callback: p => { const i=html.querySelector('#dd-textpic-sound'); if(i) i.value=p; } }).render({ force:true });
    });

    // ══════════════════════════════════════════════════════════════════════════
    // ── EDITOR MODE (Timeline + Keyframes) ───────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    // Self-contained block: drives the timeline view, keyframe panel,
    // scrubbing, live RAF preview, and bridges into the Apply flow.

    const tlState = {
      // Total timeline length in ms. Defaults to the simple-mode duration
      // slider so switching modes feels coherent.
      total: parseInt(html.querySelector('#dd-text-duration')?.value, 10) || 4000,
      // Current playhead time in ms.
      t: 0,
      // Selected clip id (string) or null.
      selectedId: null,
      // Selected keyframe id (string) or null. Used for highlighting and to
      // scroll the inspector to the matching row when a dot is clicked.
      selectedKeyId: null,
      // Active RAF id (0 when paused).
      rafId: 0,
      // Wall-clock start of last play() so we can compute t.
      playStart: 0,
      playAt: 0, // t value when play() was hit
      playing: false,
    };

    const tlView   = html.querySelector('[data-tp-view="timeline"]');
    const tlTracks = html.querySelector('#dd-tl-tracks');
    const tlRuler  = html.querySelector('#dd-tl-ruler');
    const tlHead   = html.querySelector('#dd-tl-playhead');
    const tlSide   = html.querySelector('#dd-tl-side-body');
    const tlSideHd = html.querySelector('#dd-tl-side-title');
    const tlAddKey = html.querySelector('[data-action="tl-add-key"]');
    const tlTime   = html.querySelector('#dd-tl-time');
    const tlPreview= html.querySelector('#dd-tl-preview-stage');
    const tlTotalInput = html.querySelector('#dd-tl-total-duration');

    // Collect clips fresh from the current layer arrays. Layers store their
    // per-clip metadata on themselves (`_clipId`, `_clipStart`, `_clipDuration`,
    // `_keyframes`) so editor state survives panel re-renders.
    const _collectClips = () => buildClips({
      textLayers:  _textLayers,
      imageLayers: _imageLayers,
      videoLayers: _videoLayers,
      seqLayers:   _seqLayers,
      audioLayers: _audioLayers,
      totalDuration: tlState.total,
    });

    const _setMode = (mode) => {
      const panel = html.querySelector('.dd-textpics-panel');
      if (!panel) return;
      panel.dataset.editorMode = mode === 'timeline' ? 'on' : 'off';
      html.querySelectorAll('.dd-tp-mode-btn').forEach(b => {
        const active = b.dataset.mode === mode;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      const body = html.querySelector('.dd-tp-body[data-tp-view]');
      if (body) body.hidden = (mode === 'timeline');
      if (tlView) tlView.hidden = (mode !== 'timeline');
      if (mode === 'timeline') _refreshTimeline();
    };

    html.querySelectorAll('.dd-tp-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => _setMode(btn.dataset.mode));
    });

    // ── Ruler (time scale on top of tracks) ──────────────────────────────────
    const _refreshRuler = () => {
      if (!tlRuler) return;
      tlRuler.innerHTML = '';
      const tickCount = 10;
      for (let i = 0; i <= tickCount; i++) {
        const tick = document.createElement('div');
        tick.className = 'dd-tl-tick';
        tick.style.left = `${(i / tickCount) * 100}%`;
        tick.textContent = `${Math.round((tlState.total * i / tickCount) / 100) / 10}s`;
        tlRuler.appendChild(tick);
      }
    };

    // ── Tracks (one per clip) ────────────────────────────────────────────────
    const _refreshTracks = () => {
      if (!tlTracks) return;
      tlTracks.innerHTML = '';
      const clips = _collectClips();
      if (!clips.length) {
        const empty = document.createElement('div');
        empty.className = 'dd-tl-empty';
        empty.textContent = game.i18n.localize('DDTEXTPICS.editor.noClipsHint');
        tlTracks.appendChild(empty);
        return;
      }
      const trackIcons = {
        text:     { i: 'fas fa-font',       label: game.i18n.localize('DDTEXTPICS.editor.trackText') },
        image:    { i: 'fas fa-image',      label: game.i18n.localize('DDTEXTPICS.editor.trackImage') },
        video:    { i: 'fas fa-film',       label: game.i18n.localize('DDTEXTPICS.editor.trackVideo') },
        sequence: { i: 'fas fa-photo-film', label: game.i18n.localize('DDTEXTPICS.editor.trackSeq') },
        audio:    { i: 'fas fa-volume-high',label: game.i18n.localize('DDTEXTPICS.editor.trackAudio') || 'Audio' },
      };
      clips.forEach(clip => {
        const track = document.createElement('div');
        track.className = 'dd-tl-track';
        track.dataset.clipId = clip.id;

        // Lane spans the full track width — no separate "head" column so
        // that the ruler, playhead and clip bars share one coordinate
        // space (otherwise the ruler ticks were offset by the head width).
        const lane = document.createElement('div');
        lane.className = 'dd-tl-lane';

        const clipBar = document.createElement('div');
        clipBar.className = 'dd-tl-clip' + (tlState.selectedId === clip.id ? ' selected' : '');
        clipBar.dataset.clipId = clip.id;
        const leftPct  = (clip.start / tlState.total) * 100;
        const widthPct = (clip.duration / tlState.total) * 100;
        clipBar.style.left  = `${leftPct}%`;
        clipBar.style.width = `${widthPct}%`;

        // Inner label = type icon + name; sits inside the clip bar itself.
        const meta = trackIcons[clip.type] ?? trackIcons.text;
        const labelEl = document.createElement('span');
        labelEl.className = 'dd-tl-clip-label';
        labelEl.innerHTML = `<i class="${meta.i}"></i> ${_clipLabel(clip)}`;
        clipBar.appendChild(labelEl);
        (clip.keyframes || []).forEach(k => {
          const dot = document.createElement('span');
          dot.className = 'dd-tl-key' + (tlState.selectedKeyId === k.id ? ' selected' : '');
          dot.style.left = `${(k.t / clip.duration) * 100}%`;
          dot.title = `t=${k.t}ms`;
          dot.dataset.keyId = k.id ?? '';
          dot.addEventListener('pointerdown', (ev) => {
            // Stop the parent clip's drag-handler and the lane's scrub-handler
            // so a pure dot-click just selects the keyframe.
            ev.stopPropagation();
            tlState.selectedId    = clip.id;
            tlState.selectedKeyId = k.id;
            _setPlayhead(clip.start + (k.t || 0));
            _refreshTracks();
            _refreshSide();
            // Scroll the matching keyframe card into view.
            setTimeout(() => {
              const row = tlSide?.querySelector(`.dd-tl-key-row[data-key-id="${k.id}"]`);
              if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 0);
          });
          clipBar.appendChild(dot);
        });

        // Trim handles.
        const handleL = document.createElement('div'); handleL.className = 'dd-tl-handle l';
        const handleR = document.createElement('div'); handleR.className = 'dd-tl-handle r';
        clipBar.appendChild(handleL);
        clipBar.appendChild(handleR);

        _wireClipDrag(clipBar, clip, handleL, handleR, lane);

        clipBar.addEventListener('click', (ev) => {
          if (ev.target.classList.contains('dd-tl-handle')) return; // handled below
          // Clicking outside a dot clears the keyframe selection.
          if (tlState.selectedId !== clip.id) tlState.selectedKeyId = null;
          tlState.selectedId = clip.id;
          _refreshTracks();
          _refreshSide();
        });

        lane.appendChild(clipBar);
        track.appendChild(lane);
        tlTracks.appendChild(track);
      });
    };

    const _clipLabel = (clip) => {
      const arr = clip.type === 'text' ? _textLayers
                : clip.type === 'image' ? _imageLayers
                : clip.type === 'video' ? _videoLayers
                : clip.type === 'audio' ? _audioLayers
                : _seqLayers;
      const lay = arr[clip.sourceIdx] ?? {};
      if (clip.type === 'text') return (lay.text || '').slice(0, 24) || `Text ${clip.sourceIdx + 1}`;
      if (clip.type === 'image') {
        if (lay.source && lay.source !== 'url') return `[${lay.source}]`;
        const u = lay.url || '';
        return u.split('/').pop()?.slice(0, 24) || `Image ${clip.sourceIdx + 1}`;
      }
      if (clip.type === 'audio') {
        const u = lay.url || '';
        return u.split('/').pop()?.slice(0, 24) || `Audio ${clip.sourceIdx + 1}`;
      }
      if (clip.type === 'video') {
        const u = lay.url || '';
        return u.split('/').pop()?.slice(0, 24) || `Video ${clip.sourceIdx + 1}`;
      }
      return `${clip.type} ${clip.sourceIdx + 1}`;
    };

    // ── Drag (move / trim) on a clip bar ─────────────────────────────────────
    const _wireClipDrag = (bar, clip, handleL, handleR, lane) => {
      const onDown = (mode) => (downEv) => {
        downEv.preventDefault();
        downEv.stopPropagation();
        const laneRect = lane.getBoundingClientRect();
        const startX = downEv.clientX;
        const startLeft = clip.start;
        const startDuration = clip.duration;
        const pxPerMs = laneRect.width / tlState.total;
        const lay = _layerForClip(clip);
        const onMove = (mv) => {
          const dx = mv.clientX - startX;
          const dms = dx / pxPerMs;
          if (mode === 'move') {
            let next = Math.max(0, Math.min(tlState.total - clip.duration, startLeft + dms));
            clip.start = next;
            lay._clipStart = next;
            lay._userTrimmed = true;
          } else if (mode === 'trimL') {
            let next = Math.max(0, Math.min(startLeft + startDuration - 100, startLeft + dms));
            clip.start    = next;
            clip.duration = startDuration - (next - startLeft);
            lay._clipStart    = clip.start;
            lay._clipDuration = clip.duration;
            lay._userTrimmed  = true;
          } else if (mode === 'trimR') {
            let nextD = Math.max(100, Math.min(tlState.total - clip.start, startDuration + dms));
            clip.duration = nextD;
            lay._clipDuration = nextD;
            lay._userTrimmed  = true;
          }
          _refreshTracks();
          _refreshPreviewAtTime();
        };
        const onUp = () => {
          document.removeEventListener('pointermove', onMove);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp, { once: true });
      };
      bar.addEventListener('pointerdown', (ev) => {
        if (ev.target.classList.contains('dd-tl-handle')) return;
        onDown('move')(ev);
      });
      handleL.addEventListener('pointerdown', onDown('trimL'));
      handleR.addEventListener('pointerdown', onDown('trimR'));
    };

    const _layerForClip = (clip) => {
      const arr = clip.type === 'text' ? _textLayers
                : clip.type === 'image' ? _imageLayers
                : clip.type === 'video' ? _videoLayers
                : clip.type === 'audio' ? _audioLayers
                : _seqLayers;
      return arr[clip.sourceIdx] ?? {};
    };

    // ── Side panel (keyframe editor for the selected clip) ───────────────────
    const _refreshSide = () => {
      if (!tlSide) return;
      // Preserve scroll position across rebuilds so selecting a keyframe
      // (which destroys/recreates the rows) doesn't jump the view to top.
      const prevScroll = tlSide.scrollTop;
      tlSide.innerHTML = '';
      const clips = _collectClips();
      const clip = clips.find(c => c.id === tlState.selectedId);
      if (!clip) {
        tlAddKey?.classList.add('dd-hidden');
        if (tlSideHd) tlSideHd.innerHTML = `<i class="fas fa-mouse-pointer"></i> ${game.i18n.localize('DDTEXTPICS.editor.selectClipHint')}`;
        const hint = document.createElement('div');
        hint.className = 'dd-tl-side-hint';
        hint.textContent = game.i18n.localize('DDTEXTPICS.editor.selectClipHint');
        tlSide.appendChild(hint);
        return;
      }
      tlAddKey?.classList.remove('dd-hidden');
      if (tlSideHd) tlSideHd.innerHTML = `<i class="fas fa-key"></i> ${_clipLabel(clip)} — ${clip.keyframes.length} keys`;

      // ── Source / Content block ─────────────────────────────────────────
      // (URL + file picker for image/video; multi-line text for text clips;
      //  source-mode dropdown for image clips.)
      const lay = _layerForClip(clip);
      const sourceBox = document.createElement('div');
      sourceBox.className = 'dd-tl-side-section';
      sourceBox.innerHTML = `<div class="dd-tl-side-section-title"><i class="fas fa-photo-film"></i> ${game.i18n.localize('DDTEXTPICS.editor.sectionSource') || 'Source'}</div>`;
      const sourceBody = document.createElement('div');
      sourceBody.className = 'dd-tl-side-section-body';
      sourceBox.appendChild(sourceBody);

      if (clip.type === 'text') {
        const wrap = document.createElement('label');
        wrap.className = 'dd-tl-key-field dd-tl-key-field-wide';
        wrap.innerHTML = `<span>${game.i18n.localize('DDTEXTPICS.editor.textContent') || 'Text'}</span>`;
        const ta = document.createElement('textarea');
        ta.className = 'dd-input dd-tl-textarea';
        ta.rows = 2;
        ta.value = lay.text || '';
        ta.addEventListener('input', () => {
          lay.text = ta.value;
          _refreshTracks();
          _refreshPreviewAtTime();
        });
        wrap.appendChild(ta);
        sourceBody.appendChild(wrap);
      } else if (clip.type === 'audio') {
        const urow = document.createElement('div');
        urow.className = 'dd-tl-url-row';
        const lab = document.createElement('span');
        lab.textContent = 'URL';
        const urlInp = document.createElement('input');
        urlInp.type = 'text';
        urlInp.className = 'dd-input';
        urlInp.value = lay.url || '';
        urlInp.placeholder = '*.ogg / *.mp3 / *.wav';
        urlInp.addEventListener('input', () => {
          lay.url = urlInp.value.trim();
          _refreshTracks();
          _refreshPreviewAtTime();
        });
        const browse = document.createElement('button');
        browse.type = 'button';
        browse.className = 'dd-tl-btn dd-tl-browse';
        browse.title = game.i18n.localize('DRAMADIRECTOR.tp.browse') || 'Browse';
        browse.innerHTML = '<i class="fas fa-folder-open"></i>';
        browse.addEventListener('click', () => {
          new (foundry.applications.apps.FilePicker.implementation)({
            type: 'audio', location: 'data',
            callback: (path) => {
              urlInp.value = path; lay.url = path;
              _refreshTracks(); _refreshPreviewAtTime();
            },
          }).render({ force: true });
        });
        urow.append(lab, urlInp, browse);
        sourceBody.appendChild(urow);

        // Loop checkbox for audio clips.
        const loopRow = document.createElement('label');
        loopRow.className = 'dd-tl-key-field';
        loopRow.innerHTML = `<span>${game.i18n.localize('DDTEXTPICS.editor.audioLoop') || 'Loop'}</span>`;
        const loopChk = document.createElement('input');
        loopChk.type = 'checkbox';
        loopChk.checked = !!lay.loop;
        loopChk.addEventListener('change', () => { lay.loop = loopChk.checked; });
        loopRow.appendChild(loopChk);
        const sp = document.createElement('span'); loopRow.appendChild(sp);
        sourceBody.appendChild(loopRow);
      } else if (clip.type === 'image' || clip.type === 'video') {
        if (clip.type === 'image') {
          // Source dropdown (URL / token / actor).
          const srow = document.createElement('label');
          srow.className = 'dd-tl-key-field';
          srow.innerHTML = `<span>${game.i18n.localize('DDTEXTPICS.editor.imageSource.label') || 'Source'}</span>`;
          const srcSel = document.createElement('select');
          srcSel.className = 'dd-input dd-tl-src-sel';
          [['url',           'DDTEXTPICS.editor.imageSource.url'],
           ['tokenPortrait', 'DDTEXTPICS.editor.imageSource.tokenPortrait'],
           ['tokenImage',    'DDTEXTPICS.editor.imageSource.tokenImage'],
           ['actorPortrait', 'DDTEXTPICS.editor.imageSource.actorPortrait']].forEach(([v, k]) => {
            const opt = document.createElement('option');
            opt.value = v; opt.textContent = game.i18n.localize(k);
            if ((lay.source ?? 'url') === v) opt.selected = true;
            srcSel.appendChild(opt);
          });
          srcSel.addEventListener('change', () => {
            lay.source = srcSel.value;
            _refreshTracks();
            _refreshSide();
            _refreshPreviewAtTime();
          });
          srow.appendChild(srcSel);
          // Spacer keeps the 3-col grid intact.
          const spacer = document.createElement('span');
          srow.appendChild(spacer);
          sourceBody.appendChild(srow);
        }

        // URL + file picker (only for URL source on image, always for video).
        if (clip.type === 'video' || (lay.source ?? 'url') === 'url') {
          const urow = document.createElement('div');
          urow.className = 'dd-tl-url-row';
          const lab = document.createElement('span');
          lab.textContent = 'URL';
          const urlInp = document.createElement('input');
          urlInp.type = 'text';
          urlInp.className = 'dd-input';
          urlInp.value = lay.url || '';
          urlInp.placeholder = clip.type === 'video' ? '*.webm / *.mp4' : '*.png / *.webp / *.jpg';
          urlInp.addEventListener('input', () => {
            lay.url = urlInp.value.trim();
            _refreshTracks();
            _refreshPreviewAtTime();
          });
          const browse = document.createElement('button');
          browse.type = 'button';
          browse.className = 'dd-tl-btn dd-tl-browse';
          browse.title = game.i18n.localize('DRAMADIRECTOR.tp.browse') || 'Browse';
          browse.innerHTML = '<i class="fas fa-folder-open"></i>';
          browse.addEventListener('click', () => {
            new (foundry.applications.apps.FilePicker.implementation)({
              type: clip.type === 'video' ? 'video' : 'image',
              location: 'data',
              callback: (path) => {
                urlInp.value = path;
                lay.url = path;
                _refreshTracks();
                _refreshPreviewAtTime();
              },
            }).render({ force: true });
          });
          urow.append(lab, urlInp, browse);
          sourceBody.appendChild(urow);
        }
      }
      tlSide.appendChild(sourceBox);

      // ── Baseline block (Transform / Style applied to the LAYER, not a key) ──
      const _mkBaselineField = (prop) => {
        const wrap = document.createElement('label');
        wrap.className = 'dd-tl-key-field';
        wrap.innerHTML = `<span>${game.i18n.localize(`DDTEXTPICS.editor.props.${prop.key}`)}</span>`;
        let inp, preview = null;
        const useRange = prop.type === 'number' &&
          ['scale', 'opacity', 'blur', 'fontSize'].includes(prop.key);
        const cur = (lay[prop.key] === undefined || lay[prop.key] === null) ? prop.default : lay[prop.key];
        if (prop.type === 'color') {
          inp = document.createElement('input');
          inp.type = 'color';
          inp.className = 'dd-input dd-tl-color';
          inp.value = cur;
        } else if (useRange) {
          inp = document.createElement('input');
          inp.type = 'range';
          inp.className = 'dd-input dd-tl-range';
          inp.min = prop.min; inp.max = prop.max; inp.step = prop.step;
          inp.value = cur;
          preview = document.createElement('span');
          preview.className = 'dd-tl-range-val';
          preview.textContent = String(cur);
        } else {
          inp = document.createElement('input');
          inp.type = 'number';
          inp.className = 'dd-input dd-tl-num';
          inp.min = prop.min; inp.max = prop.max; inp.step = prop.step;
          inp.value = cur;
        }
        const apply = () => {
          const v = (prop.type === 'color') ? inp.value : (parseFloat(inp.value) || 0);
          lay[prop.key] = v;
          if (preview) preview.textContent = String(v);
          _refreshPreviewAtTime();
        };
        inp.addEventListener('input',  apply);
        inp.addEventListener('change', apply);
        wrap.appendChild(inp);
        if (preview) wrap.appendChild(preview);
        return wrap;
      };

      const baselineBox = document.createElement('div');
      baselineBox.className = 'dd-tl-side-section';
      baselineBox.innerHTML = `<div class="dd-tl-side-section-title"><i class="fas fa-sliders"></i> ${game.i18n.localize('DDTEXTPICS.editor.sectionBaseline') || 'Baseline'}</div>`;
      const blBody = document.createElement('div');
      blBody.className = 'dd-tl-side-section-body';

      if (clip.type === 'audio') {
        // Audio baseline = volume only.
        const blAudio = document.createElement('div');
        blAudio.className = 'dd-tl-key-group';
        blAudio.innerHTML = `<div class="dd-tl-key-group-title"><i class="fas fa-volume-high"></i> ${game.i18n.localize('DDTEXTPICS.editor.groupAudio') || 'Audio'}</div>`;
        const blAGrid = document.createElement('div');
        blAGrid.className = 'dd-tl-key-group-grid';
        const volProp = ANIMATABLE_PROPS.find(p => p.key === 'volume');
        if (volProp) blAGrid.appendChild(_mkBaselineField(volProp));
        blAudio.appendChild(blAGrid);
        blBody.appendChild(blAudio);
      } else {
        const BL_TRANSFORM = ['x', 'y', 'scale', 'rotation'];
        const BL_STYLE     = ['opacity', 'blur', 'color', 'fontSize'];

        const blTransform = document.createElement('div');
        blTransform.className = 'dd-tl-key-group';
        blTransform.innerHTML = `<div class="dd-tl-key-group-title"><i class="fas fa-arrows-up-down-left-right"></i> ${game.i18n.localize('DDTEXTPICS.editor.groupTransform') || 'Transform'}</div>`;
        const blTGrid = document.createElement('div');
        blTGrid.className = 'dd-tl-key-group-grid';
        BL_TRANSFORM.forEach(key => {
          const prop = ANIMATABLE_PROPS.find(p => p.key === key);
          if (prop) blTGrid.appendChild(_mkBaselineField(prop));
        });
        blTransform.appendChild(blTGrid);

        const blStyle = document.createElement('div');
        blStyle.className = 'dd-tl-key-group';
        blStyle.innerHTML = `<div class="dd-tl-key-group-title"><i class="fas fa-palette"></i> ${game.i18n.localize('DDTEXTPICS.editor.groupStyle') || 'Style'}</div>`;
        const blSGrid = document.createElement('div');
        blSGrid.className = 'dd-tl-key-group-grid';
        BL_STYLE.forEach(key => {
          const prop = ANIMATABLE_PROPS.find(p => p.key === key);
          if (!prop) return;
          if (prop.textOnly && clip.type !== 'text') return;
          blSGrid.appendChild(_mkBaselineField(prop));
        });
        blStyle.appendChild(blSGrid);

        blBody.append(blTransform, blStyle);
      }
      baselineBox.appendChild(blBody);
      tlSide.appendChild(baselineBox);

      // ── Keyframes block ────────────────────────────────────────────────
      const kfBox = document.createElement('div');
      kfBox.className = 'dd-tl-side-section';
      kfBox.innerHTML = `<div class="dd-tl-side-section-title"><i class="fas fa-key"></i> ${game.i18n.localize('DDTEXTPICS.editor.sectionKeyframes') || 'Keyframes'} (${clip.keyframes.length})</div>`;

      const list = document.createElement('div');
      list.className = 'dd-tl-key-list';
      clip.keyframes.slice().sort((a, b) => a.t - b.t).forEach((k) => {
        // Ensure the keyframe has a stable id (legacy data may lack one).
        if (!k.id) k.id = foundry.utils.randomID();
        const row = document.createElement('div');
        row.className = 'dd-tl-key-row' + (tlState.selectedKeyId === k.id ? ' selected' : '');
        row.dataset.keyId = k.id;
        row.addEventListener('pointerdown', (ev) => {
          // Don't hijack typing in inputs / clicking on trash.
          if (ev.target.closest('input, select, textarea, button')) return;
          if (tlState.selectedKeyId === k.id) return; // already selected
          tlState.selectedKeyId = k.id;
          _setPlayhead(clip.start + (k.t || 0));
          // Rebuild both halves so every other row/dot drops its `.selected`
          // class — adding it to just *this* row left stale highlights behind.
          _refreshTracks();
          _refreshSide();
        });

        // ── Header row: [time | easing | trash] ─────────────────────────────
        const head = document.createElement('div');
        head.className = 'dd-tl-key-head';

        const tBox = document.createElement('input');
        tBox.type  = 'number';
        tBox.className = 'dd-input dd-tl-key-t';
        tBox.min   = 0; tBox.max = clip.duration; tBox.step = 50;
        tBox.value = Math.round(k.t);
        tBox.title = game.i18n.localize('DDTEXTPICS.editor.timeMs') || 'Time (ms)';
        tBox.addEventListener('change', () => {
          k.t = Math.max(0, Math.min(clip.duration, parseFloat(tBox.value) || 0));
          _layerForClip(clip)._keyframes = clip.keyframes;
          _refreshTracks();
          _refreshSide();
          _refreshPreviewAtTime();
        });

        const eSel = document.createElement('select');
        eSel.className = 'dd-input dd-tl-key-easing';
        ['linear', 'easeIn', 'easeOut', 'easeInOut'].forEach(e => {
          const o = document.createElement('option'); o.value = e;
          o.textContent = game.i18n.localize(`DDTEXTPICS.editor.easing.${e}`);
          if ((k.easing ?? 'easeInOut') === e) o.selected = true;
          eSel.appendChild(o);
        });
        eSel.addEventListener('change', () => {
          k.easing = eSel.value;
          _layerForClip(clip)._keyframes = clip.keyframes;
          _refreshPreviewAtTime();
        });

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'dd-tl-key-del';
        del.title = game.i18n.localize('DDTEXTPICS.editor.deleteKey');
        del.innerHTML = '<i class="fas fa-trash"></i>';
        del.addEventListener('click', () => {
          const idx = clip.keyframes.indexOf(k);
          if (idx >= 0) clip.keyframes.splice(idx, 1);
          _layerForClip(clip)._keyframes = clip.keyframes;
          _refreshTracks();
          _refreshSide();
          _refreshPreviewAtTime();
        });

        head.append(tBox, eSel, del);
        row.appendChild(head);

        // ── Property groups: Transform / Style ──────────────────────────────
        const _mkField = (prop) => {
          const wrap = document.createElement('label');
          wrap.className = 'dd-tl-key-field';
          wrap.innerHTML = `<span>${game.i18n.localize(`DDTEXTPICS.editor.props.${prop.key}`)}</span>`;
          let inp;
          let preview = null;
          // Use range slider for unit-bounded numbers; number input for x/y/rot.
          const useRange = prop.type === 'number' &&
            ['scale', 'opacity', 'blur', 'fontSize'].includes(prop.key);
          if (prop.type === 'color') {
            inp = document.createElement('input');
            inp.type = 'color';
            inp.className = 'dd-input dd-tl-color';
            inp.value = (k[prop.key] ?? prop.default);
          } else if (useRange) {
            inp = document.createElement('input');
            inp.type = 'range';
            inp.className = 'dd-input dd-tl-range';
            inp.min = prop.min; inp.max = prop.max; inp.step = prop.step;
            inp.value = (k[prop.key] ?? prop.default);
            preview = document.createElement('span');
            preview.className = 'dd-tl-range-val';
            preview.textContent = String(inp.value);
          } else {
            inp = document.createElement('input');
            inp.type = 'number';
            inp.className = 'dd-input dd-tl-num';
            inp.min = prop.min; inp.max = prop.max; inp.step = prop.step;
            inp.value = (k[prop.key] ?? prop.default);
          }
          const apply = () => {
            const v = (prop.type === 'color') ? inp.value : (parseFloat(inp.value) || 0);
            k[prop.key] = v;
            if (preview) preview.textContent = String(v);
            _layerForClip(clip)._keyframes = clip.keyframes;
            _refreshPreviewAtTime();
          };
          inp.addEventListener('input',  apply);
          inp.addEventListener('change', apply);
          wrap.appendChild(inp);
          if (preview) wrap.appendChild(preview);
          return wrap;
        };

        const TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation'];
        const STYLE_KEYS     = ['opacity', 'blur', 'color', 'fontSize'];

        if (clip.type === 'audio') {
          // Audio clips only animate volume.
          const audioBox = document.createElement('div');
          audioBox.className = 'dd-tl-key-group';
          audioBox.innerHTML = `<div class="dd-tl-key-group-title"><i class="fas fa-volume-high"></i> ${game.i18n.localize('DDTEXTPICS.editor.groupAudio') || 'Audio'}</div>`;
          const audioGrid = document.createElement('div');
          audioGrid.className = 'dd-tl-key-group-grid';
          const volProp = ANIMATABLE_PROPS.find(p => p.key === 'volume');
          if (volProp) audioGrid.appendChild(_mkField(volProp));
          audioBox.appendChild(audioGrid);
          row.appendChild(audioBox);
        } else {
          const transformBox = document.createElement('div');
          transformBox.className = 'dd-tl-key-group';
          transformBox.innerHTML = `<div class="dd-tl-key-group-title"><i class="fas fa-arrows-up-down-left-right"></i> ${game.i18n.localize('DDTEXTPICS.editor.groupTransform') || 'Transform'}</div>`;
          const transformGrid = document.createElement('div');
          transformGrid.className = 'dd-tl-key-group-grid';
          TRANSFORM_KEYS.forEach(key => {
            const prop = ANIMATABLE_PROPS.find(p => p.key === key);
            if (!prop) return;
            transformGrid.appendChild(_mkField(prop));
          });
          transformBox.appendChild(transformGrid);

          const styleBox = document.createElement('div');
          styleBox.className = 'dd-tl-key-group';
          styleBox.innerHTML = `<div class="dd-tl-key-group-title"><i class="fas fa-palette"></i> ${game.i18n.localize('DDTEXTPICS.editor.groupStyle') || 'Style'}</div>`;
          const styleGrid = document.createElement('div');
          styleGrid.className = 'dd-tl-key-group-grid';
          STYLE_KEYS.forEach(key => {
            const prop = ANIMATABLE_PROPS.find(p => p.key === key);
            if (!prop) return;
            if (prop.textOnly && clip.type !== 'text') return;
            styleGrid.appendChild(_mkField(prop));
          });
          styleBox.appendChild(styleGrid);

          row.appendChild(transformBox);
          row.appendChild(styleBox);
        }
        list.appendChild(row);
      });
      kfBox.appendChild(list);
      tlSide.appendChild(kfBox);
      // Restore the scroll position captured at the top of this function so
      // selecting a keyframe doesn't yank the side panel back to the top.
      tlSide.scrollTop = prevScroll;
    };

    tlAddKey?.addEventListener('click', () => {
      const clip = _collectClips().find(c => c.id === tlState.selectedId);
      if (!clip) return;
      const lay = _layerForClip(clip);
      const t = tlState.t;
      // If the playhead is OUTSIDE the selected clip, auto-extend the
      // clip so the keyframe lands precisely where the playhead is.
      if (t < clip.start) {
        const oldEnd = clip.start + clip.duration;
        clip.start    = t;
        clip.duration = oldEnd - t;
        lay._clipStart    = clip.start;
        lay._clipDuration = clip.duration;
        lay._userTrimmed  = true;
      } else if (t > clip.start + clip.duration) {
        clip.duration = Math.min(tlState.total - clip.start, t - clip.start);
        lay._clipDuration = clip.duration;
        lay._userTrimmed  = true;
      }
      const localT = Math.max(0, Math.min(clip.duration, t - clip.start));
      const newKey = defaultKeyframeFor(clip, localT);
      if (!Array.isArray(lay._keyframes)) lay._keyframes = [];
      lay._keyframes.push(newKey);
      _refreshTracks();
      _refreshSide();
      _refreshPreviewAtTime();
    });

    // ── Playhead + scrub ─────────────────────────────────────────────────────
    const _setPlayhead = (t) => {
      tlState.t = Math.max(0, Math.min(tlState.total, t));
      if (tlHead) tlHead.style.left = `${(tlState.t / tlState.total) * 100}%`;
      if (tlTime) tlTime.textContent = `${Math.round(tlState.t)} / ${tlState.total} ms`;
      _refreshPreviewAtTime();
    };

    // ── Scrub the playhead ──────────────────────────────────────────────────
    // - pointerdown on the ruler OR an empty area of the tracks → start drag
    // - pointerdown directly on the playhead knob → start drag from current t
    // - pointermove drags until pointerup
    const tracksWrap = html.querySelector('.dd-tl-tracks-wrap');
    const _scrubFromClientX = (clientX) => {
      if (!tracksWrap) return;
      const rect = tracksWrap.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      _setPlayhead(pct * tlState.total);
    };
    const _startScrub = (downEv) => {
      _scrubFromClientX(downEv.clientX);
      downEv.preventDefault();
      const onMove = (mv) => _scrubFromClientX(mv.clientX);
      const onUp   = () => {
        document.removeEventListener('pointermove', onMove);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once: true });
    };
    tlRuler?.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); _startScrub(ev); });
    tlHead?.addEventListener('pointerdown',  (ev) => { ev.stopPropagation(); _startScrub(ev); });
    tracksWrap?.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.dd-tl-clip')) return;
      if (ev.target.closest('.dd-tl-ruler')) return;
      if (ev.target.closest('.dd-tl-playhead')) return;
      _startScrub(ev);
    });

    // Transport controls.
    html.querySelector('[data-action="tl-play"]')?.addEventListener('click', () => {
      if (tlState.playing) return;
      tlState.playing = true;
      tlState.playStart = performance.now();
      tlState.playAt = tlState.t >= tlState.total ? 0 : tlState.t;
      const tick = () => {
        if (!tlState.playing) return;
        const elapsed = performance.now() - tlState.playStart;
        const t = tlState.playAt + elapsed;
        if (t >= tlState.total) { _setPlayhead(tlState.total); tlState.playing = false; tlState.rafId = 0; return; }
        _setPlayhead(t);
        tlState.rafId = requestAnimationFrame(tick);
      };
      tlState.rafId = requestAnimationFrame(tick);
    });
    html.querySelector('[data-action="tl-pause"]')?.addEventListener('click', () => {
      tlState.playing = false;
      if (tlState.rafId) cancelAnimationFrame(tlState.rafId);
      tlState.rafId = 0;
    });
    html.querySelector('[data-action="tl-stop"]')?.addEventListener('click', () => {
      tlState.playing = false;
      if (tlState.rafId) cancelAnimationFrame(tlState.rafId);
      tlState.rafId = 0;
      _setPlayhead(0);
    });

    // Duration input.
    tlTotalInput?.addEventListener('change', () => {
      const v = parseInt(tlTotalInput.value, 10);
      if (!Number.isFinite(v) || v < 500) return;
      tlState.total = v;
      // Clamp clips that overhang the new total.
      [..._textLayers, ..._imageLayers, ..._videoLayers, ..._seqLayers].forEach(lay => {
        if (typeof lay._clipStart === 'number' && lay._clipStart + lay._clipDuration > v) {
          lay._clipDuration = Math.max(100, v - lay._clipStart);
        }
      });
      _setPlayhead(Math.min(tlState.t, v));
      _refreshRuler();
      _refreshTracks();
    });

    // ── Live preview ─────────────────────────────────────────────────────────
    const _refreshPreviewAtTime = () => {
      if (!tlPreview) return;
      const clips = _collectClips();
      const snap = sampleAt(clips, tlState.t);
      tlPreview.innerHTML = '';
      snap.forEach(sn => {
        if (!sn.active) return;
        const clip = clips.find(c => c.id === sn.id);
        const lay = _layerForClip(clip);
        let el;
        if (sn.type === 'text') {
          el = document.createElement('div');
          el.className = 'dd-tl-pv-text';
          el.setAttribute('data-tp-text', '');
          el.textContent = lay.text || `Text ${sn.sourceIdx + 1}`;
        } else if (sn.type === 'image') {
          el = document.createElement('img');
          el.className = 'dd-tl-pv-img';
          const url = resolveImageSource(lay);
          if (url) el.src = url;
          el.onerror = () => { el.style.outline = '1px dashed rgba(200,80,80,.4)'; el.removeAttribute('src'); };
        } else if (sn.type === 'video') {
          el = document.createElement('div');
          el.className = 'dd-tl-pv-video';
          el.textContent = `🎬 ${(lay.url || '').split('/').pop() || `Video ${sn.sourceIdx + 1}`}`;
        } else if (sn.type === 'audio') {
          // Audio is invisible at runtime — show a soft badge so the user
          // sees that a clip is "playing" at the current playhead time.
          el = document.createElement('div');
          el.className = 'dd-tl-pv-audio';
          const vol = sn.values?.volume ?? lay.volume ?? 1;
          el.innerHTML = `<i class="fas fa-volume-high"></i> ${(lay.url || '').split('/').pop() || `Audio ${sn.sourceIdx + 1}`} <span class="dd-tl-pv-audio-vol">${Math.round(vol * 100)}%</span>`;
          tlPreview.appendChild(el);
          return; // Audio badge is corner-positioned via CSS; skip transforms.
        } else {
          el = document.createElement('div');
          el.className = 'dd-tl-pv-seq';
          el.textContent = `🎞 Seq ${sn.sourceIdx + 1}`;
        }
        el.style.position = 'absolute';
        el.style.left = '50%';
        el.style.top = '50%';
        el.style.transformOrigin = 'center center';
        // Apply animated values (translate from center → x/y offsets).
        const v = sn.values;
        el.style.transform = `translate(calc(-50% + ${v.x}%), calc(-50% + ${v.y}%)) scale(${v.scale}) rotate(${v.rotation}deg)`;
        el.style.opacity = String(v.opacity);
        if (v.blur > 0) el.style.filter = `blur(${v.blur}px)`;
        if (sn.type === 'text') {
          if (v.color)    el.style.color = v.color;
          if (v.fontSize) el.style.fontSize = `${v.fontSize}rem`;
          if (lay.bold)   el.style.fontWeight = '700';
          if (lay.italic) el.style.fontStyle = 'italic';
          if (lay.shadowColor) el.style.textShadow = `0 0 10px ${lay.shadowColor},0 0 20px ${lay.shadowColor}`;
        }
        tlPreview.appendChild(el);
      });
    };

    const _refreshTimeline = () => {
      // Pull total from the simple-mode duration each time we switch
      // to the timeline (unless user already customized via the input).
      const simDur = parseInt(html.querySelector('#dd-text-duration')?.value, 10);
      if (Number.isFinite(simDur) && tlTotalInput && !tlTotalInput.dataset.userTouched) {
        tlState.total = simDur;
        tlTotalInput.value = simDur;
      }
      _refreshRuler();
      _refreshTracks();
      _refreshSide();
      _setPlayhead(tlState.t);
    };

    tlTotalInput?.addEventListener('input', () => { tlTotalInput.dataset.userTouched = '1'; });

    // Hook: whenever the simple-mode panel rebuilds layers, also refresh
    // the timeline view (only if it's currently visible).
    const _origRebuildText  = _rebuildTextLayers;
    const _origRebuildImg   = _rebuildImageLayers;
    // Monkey-wrap by replacing the functions for this closure only.
    // (They're locals — we install side-effect calls via wrappers.)
    // (The original functions are still hot for the simple view.)
    // Note: these wrappers are no-ops if the timeline view is hidden.
    html.querySelector('#dd-text-layers-container')?.addEventListener('dd-rebuild', () => {
      if (!tlView?.hidden) _refreshTimeline();
    });
    html.querySelector('#dd-image-layers-container')?.addEventListener('dd-rebuild', () => {
      if (!tlView?.hidden) _refreshTimeline();
    });

    // ── Bridge collectOptions: inject timeline payload ───────────────────────
    // Capture original; override on the panel so Apply/Save send keyframes.
    const _origCollect = collectOptions;
    const _injectedCollect = () => {
      const opts = _origCollect();
      const editorOn = html.querySelector('.dd-textpics-panel')?.dataset.editorMode === 'on';
      if (!editorOn) return opts;
      // In editor mode, clip.sourceIdx is an index into the FULL layer
      // arrays (not the filtered ones the simple-mode path emits). Replace
      // the filtered arrays with the originals so the cinematic player can
      // look up clip.lay by index reliably. Strip private editor fields so
      // they don't bloat the socket payload.
      const stripPriv = (l) => {
        const { _clipId, _clipStart, _clipDuration, _keyframes, _userTrimmed, _layerIdx, ...rest } = l;
        return rest;
      };
      opts.textLayers  = _textLayers .map(stripPriv);
      opts.imageLayers = _imageLayers.map(l => ({ ...stripPriv(l), source: l.source ?? 'url' }));
      opts.videoLayers = _videoLayers.map(stripPriv);
      opts.seqLayers   = _seqLayers  .map(stripPriv);
      opts.audioLayers = _audioLayers.map(stripPriv);
      opts.timeline = {
        total: tlState.total,
        clips: _collectClips().map(c => ({
          id: c.id, type: c.type, sourceIdx: c.sourceIdx,
          start: c.start, duration: c.duration,
          baseline: c.baseline, keyframes: c.keyframes,
        })),
      };
      return opts;
    };
    // Re-assign the closure ref used by the button handlers below.
    // The Show handler already captured `collectOptions` — patch the const
    // by rebinding the reference indirectly via the global game state.
    // We attach it to the panel so existing handlers see the injected
    // version when they invoke it.  We do this by replacing the original
    // local with a wrapper on `_self`.
    // The simplest robust path: re-wire the action buttons to call the
    // injected collector directly.
    html.querySelector('[data-action="show-text"]')?.addEventListener('click', (ev) => {
      // Prevent the older handler from firing first; install a capture-phase
      // listener that calls injected collect, then stops propagation only if
      // editor mode is on.
      if (html.querySelector('.dd-textpics-panel')?.dataset.editorMode !== 'on') return;
      ev.stopImmediatePropagation();
      const opts = _injectedCollect();
      const targetUser = html.querySelector('#dd-target-user')?.value || null;
      if (opts.textLayers?.length || opts.imageLayers?.length || opts.charIntro || opts.timeline?.clips?.length) {
        const soundUrl = html.querySelector('#dd-textpic-sound')?.value?.trim();
        const soundVol = parseFloat(html.querySelector('#dd-textpic-sound-vol')?.value ?? '0.7');
        if (soundUrl) _cinematic()?.playCustomSound?.(soundUrl, { volume: soundVol });
        const dd = _cinematic();
        if (dd) dd.applyEffect('text', opts, targetUser);
        else _warnNoCinematic();
      }
    }, true);
    html.querySelector('[data-action="preset-save"]')?.addEventListener('click', (ev) => {
      // Save under the injected collector when in editor mode.
      if (html.querySelector('.dd-textpics-panel')?.dataset.editorMode !== 'on') return;
      ev.stopImmediatePropagation();
      const name = html.querySelector('#dd-preset-name')?.value?.trim(); if (!name) return;
      _saveTextPreset(name, _injectedCollect()).then(p => {
        refreshPresetDropdown(p);
        if (presetSelect) presetSelect.value = name;
      });
    }, true);

    // ── Quick-add toolbar (Add Text / Add Image / Add Video) ────────────────
    // Mounted once above the tracks area; visible only in timeline mode.
    const _mountQuickAdd = () => {
      const body = html.querySelector('.dd-tl-body');
      if (!body || body.dataset.quickAddMounted === '1') return;
      const bar = document.createElement('div');
      bar.className = 'dd-tl-quickadd';
      bar.innerHTML = `
        <button type="button" class="dd-tl-btn" data-tl-add="text" title="${game.i18n.localize('DDTEXTPICS.editor.quickAddText')}"><i class="fas fa-font"></i> <span>${game.i18n.localize('DDTEXTPICS.editor.btnText') || 'Text'}</span></button>
        <button type="button" class="dd-tl-btn" data-tl-add="image" title="${game.i18n.localize('DDTEXTPICS.editor.quickAddImage')}"><i class="fas fa-image"></i> <span>${game.i18n.localize('DDTEXTPICS.editor.btnImage') || 'Image'}</span></button>
        <button type="button" class="dd-tl-btn" data-tl-add="video" title="${game.i18n.localize('DDTEXTPICS.editor.quickAddVideo')}"><i class="fas fa-film"></i> <span>${game.i18n.localize('DDTEXTPICS.editor.btnVideo') || 'Video'}</span></button>
        <button type="button" class="dd-tl-btn" data-tl-add="audio" title="${game.i18n.localize('DDTEXTPICS.editor.quickAddAudio') || 'Add audio layer'}"><i class="fas fa-volume-high"></i> <span>${game.i18n.localize('DDTEXTPICS.editor.btnAudio') || 'Audio'}</span></button>
        <span class="dd-tl-quickadd-hint">${game.i18n.localize('DDTEXTPICS.editor.dropHint')}</span>
      `;
      body.parentNode.insertBefore(bar, body);
      body.parentNode.querySelector('[data-tl-add="text"]').addEventListener('click', () => {
        if (_textLayers.length >= 10) { ui.notifications?.warn(loc('DRAMADIRECTOR.tp.maxTextLayers')); return; }
        _textLayers.push({ text:'', style:'default', animation:'fade', scale:1, x:0, y:0, z:0, color:'#ffffff', shadowColor:'#000000', opacity:1, bold:false, italic:false, useTokenName:false, tokenNameSource:'selected', tokenNameId:'' });
        _rebuildTextLayers();
        _refreshTimeline();
      });
      body.parentNode.querySelector('[data-tl-add="image"]').addEventListener('click', () => {
        if (_imageLayers.length >= 10) { ui.notifications?.warn(loc('DRAMADIRECTOR.tp.maxImageLayers')); return; }
        _imageLayers.push({ url:'', animation:'fade', scale:1, x:0, y:0, z:0, opacity:1, source:'url' });
        _rebuildImageLayers();
        _refreshTimeline();
      });
      body.parentNode.querySelector('[data-tl-add="video"]').addEventListener('click', () => {
        _videoLayers.push({ url:'', loop:false, muted:true, fullscreen:false, scale:1, x:0, y:0, z:0, opacity:1 });
        _rebuildPreview();
        _refreshTimeline();
      });
      body.parentNode.querySelector('[data-tl-add="audio"]').addEventListener('click', () => {
        if (_audioLayers.length >= 10) { ui.notifications?.warn(loc('DRAMADIRECTOR.tp.maxAudioLayers') || 'Max 10 audio layers'); return; }
        _audioLayers.push({ url:'', volume:1, loop:false });
        _refreshTimeline();
      });
      // Drag-and-drop a file/text onto the tracks area to add a layer.
      const dropZone = html.querySelector('.dd-tl-tracks-wrap');
      if (dropZone) {
        dropZone.addEventListener('dragover', (ev) => { ev.preventDefault(); dropZone.classList.add('dd-tl-dropover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dd-tl-dropover'));
        dropZone.addEventListener('drop', (ev) => {
          ev.preventDefault();
          dropZone.classList.remove('dd-tl-dropover');
          const dt = ev.dataTransfer;
          if (!dt) return;
          if (dt.files && dt.files.length) {
            for (const f of dt.files) {
              if (f.type.startsWith('image/')) {
                if (_imageLayers.length >= 10) continue;
                _imageLayers.push({ url:f.name, animation:'fade', scale:1, x:0, y:0, z:0, opacity:1, source:'url' });
              } else if (f.type.startsWith('video/')) {
                _videoLayers.push({ url:f.name, loop:false, muted:true, fullscreen:false, scale:1, x:0, y:0, z:0, opacity:1 });
              } else if (f.type.startsWith('audio/')) {
                if (_audioLayers.length >= 10) continue;
                _audioLayers.push({ url:f.name, volume:1, loop:false });
              }
            }
            _rebuildImageLayers();
            _refreshTimeline();
            return;
          }
          const txt = dt.getData('text/plain');
          if (txt) {
            if (_textLayers.length >= 10) return;
            _textLayers.push({ text: txt, style:'default', animation:'fade', scale:1, x:0, y:0, z:0, color:'#ffffff', shadowColor:'#000000', opacity:1, bold:false, italic:false, useTokenName:false, tokenNameSource:'selected', tokenNameId:'' });
            _rebuildTextLayers();
            _refreshTimeline();
          }
        });
      }
      body.dataset.quickAddMounted = '1';
    };
    _mountQuickAdd();

    // ── Init editor (build initial timeline once if user opens panel in mode) ─
    _refreshTimeline();

    // ── Init ──────────────────────────────────────────────────────────────────
    _rebuildTextLayers();
    _rebuildImageLayers();
    populateTokens();
    refreshPresetDropdown();
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// VIDEO PANEL
// ═══════════════════════════════════════════════════════════════════════════

