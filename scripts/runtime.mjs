import { sampleAt, resolveImageSource } from './editor-engine.mjs';
const MID = 'drama-director-textpics', SOCKET = `module.${MID}`;
const clone = value => foundry.utils.deepClone(value);
const number = (value, fallback, min = -Infinity, max = Infinity) => Number.isFinite(Number(value)) ? Math.min(max,Math.max(min,Number(value))) : fallback;
const TYPES = { text:'textLayers', image:'imageLayers', video:'videoLayers', sequence:'seqLayers', audio:'audioLayers' };
export function sequenceFrame(layer, time) {
  const match = String(layer.firstFile || '').match(/^(.*?)(\d+)(\.[^.]+)$/), last = String(layer.lastFile || '').match(/^(.*?)(\d+)(\.[^.]+)$/);
  if (!match || !last || match[1] !== last[1] || match[3] !== last[3]) return layer.firstFile || '';
  const start=Number(match[2]), end=Number(last[2]), count=end-start+1;
  if (count<1 || count>10000) return layer.firstFile;
  let frame=Math.floor(Math.max(0,time)/1000*number(layer.fps,24,1,60));
  frame=layer.loop===false ? Math.min(frame,count-1) : frame%count;
  return `${match[1]}${String(start+frame).padStart(match[2].length,'0')}${match[3]}`;
}
export function prepareOptions(options = {}) {
  const opts=clone(options);
  for (const key of Object.values(TYPES)) opts[key] = Array.isArray(opts[key]) ? opts[key].slice(0,100) : [];
  opts.imageLayers=opts.imageLayers.map(l=>({...l,url:resolveImageSource(l),source:'url'}));
  const tokens=globalThis.canvas?.tokens;
  opts.textLayers=opts.textLayers.map(l=>{
    if (!l.useTokenName) return l;
    const token=l.tokenNameSource==='dropdown' ? tokens?.placeables?.find(t=>t.id===l.tokenNameId) : tokens?.controlled?.[0];
    return {...l,text:token?.document?.name || token?.name || l.text || '',useTokenName:false};
  });
  if(opts.charIntro) {
    const token=opts.useSelectedToken ? tokens?.controlled?.[0] : tokens?.placeables?.find(t=>t.id===opts.tokenId);
    opts.portrait={url:token?.actor?.img || token?.document?.texture?.src || '',name:token?.document?.name || ''};
  }
  return opts;
}
function animationFrames(type) {
  const hidden={opacity:0};
  const deltas={slideUp:'translateY(80px)',slideDown:'translateY(-80px)',slideLeft:'translateX(-120px)',slideRight:'translateX(120px)',zoom:'scale(.5)',zoomIn:'scale(.5)',impact:'scale(1.7)',bounce:'translateY(-100px)',flip:'perspective(800px) rotateX(80deg)',flipY:'perspective(800px) rotateY(80deg)',rise:'translateY(40px) scale(.95)',drop:'translateY(-40px) scale(.95)',spin:'scale(.5) rotate(-180deg)'};
  if (deltas[type]) hidden.transform=deltas[type];
  if(type==='blur') hidden.filter='blur(18px)';
  if(type==='swipeLeft'||type==='typewriter') hidden.clipPath='inset(0 100% 0 0)';
  if(type==='swipeRight') hidden.clipPath='inset(0 0 0 100%)';
  if(type==='shake'||type==='glitch') return [{transform:'translateX(-10px)'},{transform:'translateX(10px)'},{transform:'translateX(-5px)'},{transform:'none'}];
  return [hidden,{opacity:1,transform:'none',filter:'none',clipPath:'inset(0 0 0 0)'}];
}
class OverlayPlayback {
  constructor(options, finished) {
    this.options=options;this.finished=finished;this.entries=[];this.closed=false;
    this.total=number(options.timeline?.total ?? options.duration,4000,100,3600000);
    this.root=document.createElement('div');this.root.id='dd-textpics-runtime';this.root.setAttribute('aria-live','polite');
    this.root.style.cssText='position:fixed;inset:0;z-index:100;pointer-events:none;overflow:hidden;';
    this.effects=document.createElement('div');this.effects.className='dd-tp-screen-effects';this.root.append(this.effects);
    this.stage=document.createElement('div');this.stage.style.cssText='position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:center;';this.root.append(this.stage);document.body.append(this.root);
    this.resize=()=>this.stage.style.transform=`translate(-50%,-50%) scale(${Math.min(innerWidth/1920,innerHeight/1080)})`;this.resize();window.addEventListener('resize',this.resize);
    this.addEffects(options.screenEffects || []);
    if(options.timeline?.clips?.length) {
      for(const clip of options.timeline.clips.slice(0,300)) {
        const layer=options[TYPES[clip.type]]?.[clip.sourceIdx];if(layer)this.add(clip.type,layer,{...clip,start:number(clip.start,0,0,this.total),duration:number(clip.duration,this.total,1,this.total),baseline:clip.baseline||{},keyframes:clip.keyframes||[]});
      }
    } else {
      for(const [type,key] of Object.entries(TYPES)) for(const layer of options[key] || []) this.add(type,layer);
    }
    if(options.charIntro && options.portrait?.url) this.add('image',{url:options.portrait.url,scale:options.portraitScale??1,x:options.portraitX??0,y:options.portraitY??0,z:options.portraitZ??0,animation:options.charIntroAnim,portrait:true});
    if(options.soundUrl)this.add('audio',{url:options.soundUrl,volume:options.soundVol??.7,fadeOut:options.soundFadeOut});
    this.start=performance.now();this.tick(this.start);
  }
  add(type,layer,clip=null) {
    const entry={type,layer,clip,active:false,started:false};this.entries.push(entry);
    if(type==='audio') {entry.media=new Audio(layer.url || '');entry.media.loop=!!layer.loop;return;}
    const wrapper=entry.wrapper=document.createElement('div');
    wrapper.style.cssText=`position:absolute;inset:0;display:flex;align-items:${layer.style==='bottom'?'flex-end':'center'};justify-content:${layer.style==='left-block'?'flex-start':layer.style==='right-block'?'flex-end':'center'};z-index:${number(layer.z,0)};pointer-events:none;`;
    const transform=entry.transform=document.createElement('div'); transform.style.cssText='transform-origin:center;display:flex;max-width:100%;';
    const anim=entry.anim=document.createElement('div');anim.style.cssText='display:flex;max-width:100%;';
    const media=entry.media=document.createElement(type==='text'?'div':type==='video'?'video':'img');
    if(type==='text') {
      media.className=`dd-dramatic-text style-${['default','left-block','right-block','bottom','chapter','horror','anime'].includes(layer.style)?layer.style:'default'}`;
      media.textContent=String(layer.text || '');media.style.whiteSpace='pre-wrap';
      if(layer.bold)media.style.fontWeight='bold';if(layer.italic)media.style.fontStyle='italic';
      if(layer.shadowColor)media.style.textShadow=`0 0 10px ${layer.shadowColor}`;
      if(layer.fontFamily)media.style.fontFamily=layer.fontFamily;
    } else {
      media.src=type==='sequence'?sequenceFrame(layer,0):(layer.url||'');
      media.style.cssText=layer.fullscreen?'width:1920px;height:1080px;object-fit:cover;':'max-width:1920px;max-height:1080px;object-fit:contain;';
      if(layer.portrait) {media.style.maxHeight='850px';if(!this.options.hidePortraitFrame){media.style.border='2px solid rgba(255,255,255,.5)';media.style.borderRadius='8px';}}
      if(type==='video') {media.loop=!!layer.loop;media.muted=layer.muted!==false;media.playsInline=true;media.preload='auto';}
    }
    media.addEventListener('error',()=>{console.warn('[DD TextPics] media unavailable',type,layer.url||layer.firstFile);if(entry.wrapper)entry.wrapper.hidden=true;},{once:true});
    anim.append(media);transform.append(anim);wrapper.append(transform);this.stage.append(wrapper);
  }
  addEffects(effects) {
    const filters=[];
    const map={grayscale:'grayscale(1)',sepia:'sepia(.9)',sketch:'grayscale(1) contrast(2)',high:'saturate(2.3) hue-rotate(25deg)',film:'sepia(.3) contrast(1.15)'};
    for(const name of effects.slice(0,15)) {
      if(map[name]) filters.push(map[name]);
      const el=document.createElement('div');el.className=`dd-tp-fx dd-tp-fx-${name}`;this.effects.append(el);
      if(name==='sakura'||name==='hearts') for(let i=0;i<16;i++) { const particle=document.createElement('span');particle.textContent=name==='hearts'?'♥':'✿';particle.style.cssText=`left:${(i*37)%100}%;animation-delay:${-(i%7)}s;animation-duration:${6+i%4}s;`;el.append(particle); }
    }
    this.effects.style.backdropFilter=filters.join(' ');
  }
  tick(now) {
    if(this.closed)return;
    const elapsed=now-this.start,t=Math.min(elapsed,this.total);
    if(elapsed>=this.total&&!this.options.holdUntilDismissed)return this.stop();
    for(const e of this.entries) {
      // Held compositions retain the last frame of clips ending at the timeline boundary.
      const active=!e.clip || t>=e.clip.start && (t<e.clip.start+e.clip.duration || this.options.holdUntilDismissed&&t===this.total&&e.clip.start+e.clip.duration>=this.total);
      if(e.wrapper)e.wrapper.style.display=active?'flex':'none';
      const isMedia=e.type==='audio'||e.type==='video';
      if(!active){if(e.active&&isMedia)e.media.pause();e.active=false;continue;}
      const local=e.clip ? t-e.clip.start : t;
      const values=e.clip ? sampleAt([e.clip],t)[0].values : {x:e.layer.x??0,y:e.layer.y??0,scale:e.layer.scale??1,rotation:e.layer.rotation??0,opacity:e.layer.opacity??1,blur:e.layer.blur??0,color:e.layer.color,fontSize:e.layer.fontSize,volume:e.layer.volume??1};
      if(isMedia){
        let vol=number(values.volume,e.layer.volume??1,0,1);
        if(e.layer.fadeOut)vol*=Math.min(1,Math.max(0,(this.total-t)/600));e.media.volume=vol;
        if(!e.active&&!e.started){e.started=true;e.media.play().catch(err=>console.warn('[DD TextPics] playback blocked; interact with the page first',err));}
      }
      if(e.wrapper){
        // Simple-mode x/y are screen percentages, as in the editor's 1920x1080 preview.
        // Timeline x/y follow its clip-local percentage convention.
        if(e.clip) { e.wrapper.style.transform='';e.transform.style.transform=`translate(${number(values.x,0)}%,${number(values.y,0)}%) scale(${number(values.scale,1)}) rotate(${number(values.rotation,0)}deg)`; }
        else {e.wrapper.style.transform=`translate(${number(values.x,0)}%,${number(values.y,0)}%)`;e.transform.style.transform=`scale(${number(values.scale,1)}) rotate(${number(values.rotation,0)}deg)`;}
        e.transform.style.opacity=number(values.opacity,1,0,1);e.transform.style.filter=number(values.blur,0,0,100)>0?`blur(${values.blur}px)`:'';
        if(e.type==='text'){if(values.color)e.media.style.color=values.color;if(values.fontSize)e.media.style.fontSize=`${values.fontSize}rem`;}
        if(e.type==='sequence'){const src=sequenceFrame(e.layer,local);if(e.media.getAttribute('src')!==src)e.media.src=src;}
        if(!e.active&&!e.started){e.started=true;if(e.layer.animation!=='none'&&!matchMedia('(prefers-reduced-motion: reduce)').matches)e.anim.animate(animationFrames(e.layer.animation),{duration:Math.min(600,e.clip?.duration??this.total),easing:e.layer.animation==='typewriter'?'steps(30,end)':'ease-out'});}
      }
      e.active=true;
    }
    // Hold state needs no busy RAF after the final frame. Looping media keep playing.
    if(elapsed<this.total)this.frame=requestAnimationFrame(n=>this.tick(n));
  }
  stop(){if(this.closed)return;this.closed=true;cancelAnimationFrame(this.frame);window.removeEventListener('resize',this.resize);for(const e of this.entries)if(e.type==='audio'||e.type==='video'){e.media.pause();e.media.removeAttribute('src');e.media.load();}this.root.remove();this.finished?.();}
}
export const TextPicsRuntime={
  _playback:null,
  init(){if(this._initialized)return;this._initialized=true;game.socket.on(SOCKET,data=>this.receive(data));},
  receive(data){
    if(!data||typeof data!=='object'||data.senderId===game.user?.id)return;
    // Socket payloads have no cryptographic sender identity. Never execute code from them.
    if(!game.users.get(data.senderId)?.isGM)return;
    if(data.targetUser&&data.targetUser!==game.user?.id)return;
    if(data.action==='dismiss')this.stopLocal();
    else if(data.action==='show'&&data.options&&typeof data.options==='object')this.showLocal(data.options);
  },
  showLocal(options){this.stopLocal();this._playback=new OverlayPlayback(options,()=>{this._playback=null;});},
  stopLocal(){this._playback?.stop();this._playback=null;},
  applyEffect(type,options,targetUser=null){
    if(!game.user?.isGM||type!=='text')return;
    const opts=prepareOptions(options);
    game.socket.emit(SOCKET,{action:'show',senderId:game.user.id,targetUser,options:opts});
    if(!targetUser||targetUser===game.user.id)this.showLocal(opts);
  },
  dismissText(targetUser=null){if(!game.user?.isGM)return;game.socket.emit(SOCKET,{action:'dismiss',senderId:game.user.id,targetUser});if(!targetUser||targetUser===game.user.id)this.stopLocal();},
  clearEffects(targetUser=null){this.dismissText(targetUser);},
  generateTextMacro(options,targetUser=null){return `game.modules.get('${MID}').api.applyEffect('text', ${JSON.stringify(options,null,2)}, ${JSON.stringify(targetUser)});`;},
};
