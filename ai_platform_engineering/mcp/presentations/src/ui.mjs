import { normalizeTeamText, rankTeams, teamLabel, teamDescription, createSearchablePicker } from './picker.mjs';
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const paths = {
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
  download: 'M12 3v12 M7 10l5 5 5-5 M5 16v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  plus: 'M12 5v14 M5 12h14',
  chevron: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12 M18 6 6 18',
  layers: 'M12 3 2 8l10 5 10-5-10-5z M2 12l10 5 10-5 M2 16l10 5 10-5',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 3 M18 18a8 8 0 0 1-13-3',
  check: 'M5 12l4 4L19 6',
  clock: 'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
};
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"/></svg>`;

/** Consume the host's presentation context, never identity or arbitrary CSS. */
export function readHostAppearance(event, origin, parent) {
  const data = event.data;
  if (event.origin !== origin || event.source !== parent || !data || data.appId !== 'presentations' ||
      data.version !== '1.0' || data.type !== 'caipe.microfrontend.initialize.v1') return null;
  const theme = data.context?.theme;
  const shadows = data.context?.preferences?.shadows_enabled;
  return { theme: ['dark', 'light'].includes(theme) ? theme : undefined, shadows: typeof shadows === 'boolean' ? shadows : undefined };
}

function pickerMarkup(id, label, placeholder, multiple = false) {
  return `<div class="picker" id="${id}-picker"><button id="${id}-trigger" data-trigger type="button" class="picker-trigger" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-controls="${id}-options" aria-labelledby="${id}-label ${id}-value"${multiple ? '' : ' aria-required="true"'}><span data-value id="${id}-value">${placeholder}</span>${svg('chevron')}</button><div data-popup class="picker-popup" hidden><div class="picker-search">${svg('search')}<input type="search" aria-label="Search ${label}" aria-controls="${id}-options" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search teams by name or slug…"></div><div id="${id}-options" role="listbox" aria-labelledby="${id}-label"${multiple ? ' aria-multiselectable="true"' : ''} class="picker-options"></div><div role="status" aria-live="polite" class="picker-status"></div></div></div>`;
}

export function page(basePath) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Presentation Generator</title>
<style>
:root{color-scheme:dark;--background:230 25% 5%;--foreground:210 40% 98%;--card:230 25% 7%;--muted:230 20% 12%;--muted-foreground:215 18% 66%;--border:230 20% 18%;--primary:215 48% 64%;--primary-foreground:230 25% 5%;--success:160 65% 64%;--shadow:0 4px 20px #00000012}
:root[data-theme=light]{color-scheme:light;--background:220 18% 94%;--foreground:224 35% 13%;--card:0 0% 100%;--muted:220 14% 96%;--muted-foreground:220 9% 43%;--border:220 13% 88%;--primary:215 48% 45%;--primary-foreground:0 0% 100%;--success:160 75% 28%;--shadow:0 4px 20px #18223206}
@media(prefers-color-scheme:light){:root:not([data-theme]){color-scheme:light;--background:220 18% 94%;--foreground:224 35% 13%;--card:0 0% 100%;--muted:220 14% 96%;--muted-foreground:220 9% 43%;--border:220 13% 88%;--primary:215 48% 45%;--primary-foreground:0 0% 100%;--success:160 75% 28%;--shadow:0 4px 20px #18223206}}
:root[data-interface-shadows=off]{--shadow:none}*{box-sizing:border-box}body{margin:0;background:hsl(var(--background));color:hsl(var(--foreground));font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select{font:inherit}button,a,input,select,summary{-webkit-tap-highlight-color:transparent}button,a{touch-action:manipulation}button{cursor:pointer}button:disabled{cursor:wait;opacity:.55}a{color:inherit;text-decoration:none}svg{width:18px;height:18px;flex:none}h1,h2,h3,p{margin:0}h1{font-size:30px;line-height:1.2;letter-spacing:-1px;font-weight:650}h2{font-size:16px;letter-spacing:-.25px;font-weight:600}h3{font-size:14px;font-weight:600}.muted{color:hsl(var(--muted-foreground))}.small{font-size:12px}.eyebrow{font-size:11px;font-weight:650;letter-spacing:1.6px;text-transform:uppercase;color:hsl(var(--muted-foreground));margin-bottom:10px}
main{max-width:1320px;margin:auto;padding:38px 36px 48px}.page-header{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:24px}.page-header p{margin-top:10px;max-width:680px}.button{border:1px solid hsl(var(--border));background:hsl(var(--card));color:inherit;min-height:38px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:8px 13px;border-radius:8px;font-weight:550;white-space:nowrap}.button:hover{background:hsl(var(--muted))}.button.primary{background:hsl(var(--primary));color:hsl(var(--primary-foreground));border-color:transparent}.button.primary:hover{filter:brightness(1.08)}.button.icon-only{padding:8px;width:38px}.button.ghost{background:transparent;border-color:transparent}.privacy{display:flex;align-items:center;gap:9px;padding:12px 15px;border:1px solid hsl(var(--border));border-radius:9px;color:hsl(var(--muted-foreground));margin-bottom:24px;background:hsl(var(--card))}.privacy svg{width:15px;height:15px;color:hsl(var(--primary))}.privacy strong{color:hsl(var(--foreground));font-weight:550}.privacy .retention{margin-left:auto;display:flex;align-items:center;gap:6px;white-space:nowrap}
.workspace{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:24px;align-items:start}.panel{border:1px solid hsl(var(--border));border-radius:12px;background:hsl(var(--card));box-shadow:var(--shadow);overflow:hidden}.panel-title{padding:20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid hsl(var(--border))}.panel-title .count{font-size:12px;padding:2px 7px;background:hsl(var(--muted));border-radius:5px;color:hsl(var(--muted-foreground));font-weight:500}.panel-title .button{margin-left:auto}.toolbar{display:flex;gap:12px;align-items:center;padding:16px 20px;border-bottom:1px solid hsl(var(--border))}.search{display:flex;align-items:center;gap:9px;background:hsl(var(--background));border:1px solid hsl(var(--border));border-radius:7px;padding:0 11px;min-width:0;flex:1}.search svg{color:hsl(var(--muted-foreground));width:16px}.search input{width:100%;border:0;background:transparent;color:inherit;padding:9px 0;outline:none;min-width:0}.search:focus-within{outline:2px solid hsl(var(--primary));outline-offset:2px}input::placeholder{color:hsl(var(--muted-foreground))}.sort{background:transparent;color:inherit;border:1px solid hsl(var(--border));border-radius:7px;padding:8px;max-width:160px}
.deck-row{padding:20px;display:flex;gap:14px;align-items:center;border-bottom:1px solid hsl(var(--border))}.deck-row:last-child{border:0}.deck-row:hover{background:hsl(var(--muted)/.3)}.file-icon{width:43px;height:50px;border:1px solid hsl(var(--border));border-radius:8px;display:grid;place-items:center;background:hsl(var(--muted));color:hsl(var(--primary));flex:none}.file-icon svg{width:23px;height:23px}.deck-info{min-width:0;flex:1}.deck-title{display:flex;align-items:center;gap:8px;margin-bottom:6px}.deck-title h3{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.deck-meta{display:flex;gap:7px 12px;align-items:center;flex-wrap:wrap;font-size:12px;color:hsl(var(--muted-foreground))}.badge{font-size:10px;text-transform:uppercase;font-weight:600;letter-spacing:.3px;display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border:1px solid hsl(var(--border));border-radius:5px;white-space:nowrap}.badge.default{color:hsl(var(--success));background:hsl(var(--success)/.07);border-color:hsl(var(--success)/.2)}.badge svg{width:11px;height:11px}.download{font-size:12px;min-height:34px}.download svg{width:15px}.deck-actions{display:flex;align-items:center;gap:6px;flex:none}.deck-actions .button{font-size:12px;min-height:34px}.deck-actions .icon-only{width:34px}.button.kept{color:hsl(var(--success))}.button.danger{color:#ef9999}.button.danger:hover{background:#a3262622}:root[data-theme=light] .button.danger{color:#a32626}.panel-foot{border-top:1px solid hsl(var(--border));padding:12px 20px;font-size:12px;color:hsl(var(--muted-foreground));display:flex;gap:7px;align-items:center}.panel-foot svg{width:13px}.sidebar{display:grid;gap:20px}.templates-intro{padding:16px 20px 0}.template{padding:18px 20px;border-bottom:1px solid hsl(var(--border))}.template:last-child{border:0}.template-title{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:7px}.template-title h3{line-height:1.5}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:13px}.chip{padding:3px 7px;border:1px solid hsl(var(--border));border-radius:5px;color:hsl(var(--muted-foreground));font-size:11px}.template-owner{overflow-wrap:anywhere}.create-card{padding:20px}.create-icon{color:hsl(var(--primary));display:inline-flex;background:hsl(var(--primary)/.1);padding:9px;border-radius:9px;margin-bottom:13px}.create-card p{margin:8px 0 16px;line-height:1.7}.create-card a{display:flex;justify-content:space-between;width:100%}
.empty{padding:56px 24px;text-align:center;display:grid;justify-items:center;gap:10px}.empty-icon{width:54px;height:54px;display:grid;place-items:center;border:1px solid hsl(var(--border));background:hsl(var(--muted));border-radius:13px;color:hsl(var(--muted-foreground));margin-bottom:5px}.empty-icon svg{width:25px;height:25px}.empty p{max-width:340px}.empty a{margin-top:9px}.skeleton-row{padding:22px 20px;display:flex;align-items:center;gap:14px;border-bottom:1px solid hsl(var(--border))}.skeleton{background:hsl(var(--muted));border-radius:6px;animation:pulse 1.7s ease-in-out infinite}.skeleton.icon{width:43px;height:50px}.skeleton.line{height:12px;width:65%;margin:8px 0}.skeleton.line.short{width:40%}@keyframes pulse{50%{opacity:.45}}@media(prefers-reduced-motion:reduce){*{animation:none!important;scroll-behavior:auto!important}}
#message:empty{display:none}#message{padding:12px 15px;border:1px solid hsl(var(--border));border-radius:8px;margin-bottom:20px;background:hsl(var(--muted));overflow-wrap:anywhere}#message[data-kind=error]{border-color:#e0717166;color:#ef9999}:root[data-theme=light] #message[data-kind=error]{color:#a32626}
dialog{color:inherit;background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:14px;width:min(580px,calc(100vw - 32px));padding:0;max-height:90vh;box-shadow:var(--shadow)}dialog::backdrop{background:#0008;backdrop-filter:blur(3px)}.dialog-heading{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid hsl(var(--border))}.dialog-heading h2{font-size:18px}.form-body{padding:20px 24px}.form-body>p{margin-bottom:20px}label,legend{display:block;font-size:12px;font-weight:550;margin-bottom:7px}.field{margin:18px 0}.field input:not([type=file]),.field select{width:100%;padding:10px 11px;background:hsl(var(--background));color:inherit;border:1px solid hsl(var(--border));border-radius:7px;min-height:41px}.hint{font-size:12px;color:hsl(var(--muted-foreground));margin-top:6px}.file-choice{display:flex;align-items:center;gap:12px;padding:17px;border:1px dashed hsl(var(--border));border-radius:8px;cursor:pointer;background:hsl(var(--background));margin:0}.file-choice>svg{color:hsl(var(--primary));width:25px;height:25px}.file-choice strong{display:block;font-size:13px;font-weight:550}.file-choice span{display:block;font-size:12px;font-weight:400;color:hsl(var(--muted-foreground));margin-top:3px}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.selected-teams{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.selected-team{display:inline-flex;align-items:center;gap:5px;padding:4px 7px;background:hsl(var(--muted));border-radius:5px;font-size:12px}.selected-team button{border:0;background:none;color:inherit;display:flex;padding:2px}.selected-team svg{width:12px;height:12px}.dialog-actions{border-top:1px solid hsl(var(--border));padding:16px 24px;display:flex;justify-content:flex-end;gap:9px}.form-message{font-size:13px;min-height:0;color:hsl(var(--muted-foreground));overflow-wrap:anywhere}.form-message:empty{display:none}fieldset{border:0;padding:0;margin:0}:focus-visible{outline:2px solid hsl(var(--primary));outline-offset:3px}[hidden]{display:none!important}
@media(max-width:1050px){.workspace{grid-template-columns:minmax(0,1fr) 275px}.deck-row{gap:10px;padding:18px 16px}.download{padding:7px 9px}.deck-meta{gap:4px 8px}}
@media(max-width:850px){main{padding:26px 20px}.workspace{grid-template-columns:1fr}.sidebar{grid-template-columns:1fr 1fr}.privacy{align-items:flex-start}.privacy .retention{display:none}.page-header{align-items:flex-start}h1{font-size:27px}}
@media(max-width:560px){main{padding:24px 16px}.page-header{display:block}.page-header>.button{margin-top:18px}.sidebar{grid-template-columns:1fr}.toolbar{padding:14px;gap:8px}.sort{max-width:125px;font-size:12px}.deck-row{align-items:flex-start;flex-wrap:wrap}.deck-info{flex-basis:calc(100% - 58px)}.deck-row>.deck-actions{margin-left:57px;flex-wrap:wrap}.deck-title{align-items:flex-start}.deck-title h3{white-space:normal;overflow-wrap:anywhere}.dialog-heading,.form-body,.dialog-actions{padding-left:18px;padding-right:18px}.file-icon{width:40px;height:46px}}
.picker-trigger{display:flex;width:100%;align-items:center;justify-content:space-between;gap:12px;padding:10px 11px;background:hsl(var(--background));color:inherit;border:1px solid hsl(var(--border));border-radius:7px;font-weight:400;text-align:left;min-height:42px}.picker-trigger [data-value]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.picker-trigger svg{width:16px;height:16px;color:hsl(var(--muted-foreground))}.picker-trigger[aria-expanded=true]{outline:2px solid hsl(var(--primary));outline-offset:2px}.picker-popup{position:fixed;inset:auto;margin:0;padding:0;border:1px solid hsl(var(--border));border-radius:10px;background:hsl(var(--card));color:hsl(var(--foreground));box-shadow:var(--shadow);z-index:20;display:flex;flex-direction:column;overflow:hidden;font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.picker-search{display:flex;align-items:center;gap:8px;padding:12px;border-bottom:1px solid hsl(var(--border));flex:none}.picker-search:focus-within{outline:2px solid hsl(var(--primary));outline-offset:-3px;border-radius:8px 8px 0 0}.picker-search svg{width:16px;color:hsl(var(--muted-foreground))}.picker-search input{width:100%;padding:0;min-width:0;border:0;background:transparent;color:inherit;outline:none;font:inherit}.picker-options{max-height:230px;overflow-y:auto;overscroll-behavior:contain;min-height:0;padding:5px}.picker-options:empty{display:none}.picker-option{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:9px 10px;text-align:left;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit}.picker-option>span:first-child{min-width:0}.picker-label{display:block;overflow-wrap:anywhere}.picker-slug{display:block;margin-top:2px;color:hsl(var(--muted-foreground));font-size:12px;overflow-wrap:anywhere}.picker-option:hover,.picker-option[data-active=true]{background:hsl(var(--primary)/.13)}.picker-option[aria-disabled=true]{opacity:.4;cursor:default}.picker-option[aria-selected=true] .picker-check{color:hsl(var(--primary))}.picker-check{width:16px;flex:none}.picker-status{padding:10px 12px;border-top:1px solid hsl(var(--border));font-size:12px;color:hsl(var(--muted-foreground));flex:none}
</style></head>
<body data-base="${escapeHtml(basePath)}"><main>
<header class="page-header"><div><div class="eyebrow">Your workspace</div><h1>Presentation Generator</h1><p class="muted">Download presentations created by your agents, all in one place.</p></div><button id="open-upload" class="button" type="button" hidden>${svg('plus')}Add template</button></header>
<div class="privacy">${svg('lock')}<span><strong>Private to you.</strong> Only you can see and download your generated PowerPoints.</span><span class="retention">${svg('clock')}Auto-delete after 7 days unless kept</span></div>
<div id="message" role="status" aria-live="polite"></div>
<div class="workspace"><section class="panel" aria-labelledby="decks-heading"><div class="panel-title"><h2 id="decks-heading">My PowerPoints</h2><span id="deck-count" class="count" aria-live="polite">—</span><button id="refresh" class="button icon-only ghost" type="button" aria-label="Refresh PowerPoints" title="Refresh PowerPoints">${svg('refresh')}</button></div>
<div class="toolbar"><label class="search" for="search">${svg('search')}<span class="visually-hidden">Search my PowerPoints</span><input id="search" type="search" placeholder="Search PowerPoints…" autocomplete="off"></label><label class="visually-hidden" for="sort">Sort PowerPoints</label><select id="sort" class="sort"><option value="recent">Newest first</option><option value="expiry">Expiring soon</option><option value="name">Name A–Z</option></select></div>
<div id="artifacts" aria-live="polite" aria-busy="true"><div class="skeleton-row"><div class="skeleton icon"></div><div style="flex:1"><div class="skeleton line"></div><div class="skeleton line short"></div></div></div><div class="skeleton-row"><div class="skeleton icon"></div><div style="flex:1"><div class="skeleton line"></div><div class="skeleton line short"></div></div></div></div>
<div class="panel-foot">${svg('lock')}Keep a PowerPoint to turn off auto-delete. Downloads require your sign-in and current template access.</div></section>
<aside class="sidebar"><section class="panel" aria-labelledby="templates-heading"><div class="panel-title">${svg('layers')}<h2 id="templates-heading">Team templates</h2></div><p class="templates-intro muted small">Shared with your teams. Your generated PowerPoints stay private.</p><div id="templates" aria-busy="true"><div class="template muted">Loading templates…</div></div></section>
<section class="panel create-card"><div class="create-icon">${svg('plus')}</div><h2>Create with an agent</h2><p class="muted">Ask an agent to create a PowerPoint using a team template. Your download will appear here when it’s ready.</p><a class="button" href="/chat" target="_top">Open chat${svg('arrow')}</a></section></aside></div>
<dialog id="delete-dialog" aria-labelledby="delete-heading" aria-describedby="delete-description"><div class="dialog-heading"><h2 id="delete-heading">Delete PowerPoint?</h2></div><div class="form-body"><p id="delete-description"></p><p class="hint">The stored file and download link will be permanently removed. This cannot be undone.</p><p id="delete-message" class="form-message" role="status"></p></div><div class="dialog-actions"><button id="cancel-delete" class="button" type="button" autofocus>Cancel</button><button id="confirm-delete" class="button danger" type="button">Delete PowerPoint</button></div></dialog>
<dialog id="upload-dialog" aria-labelledby="upload-heading"><div class="dialog-heading"><h2 id="upload-heading">Add a team template</h2><button class="button icon-only ghost" id="close-upload" type="button" aria-label="Close template upload">${svg('close')}</button></div>
<form id="upload"><div class="form-body"><p class="muted">Templates are shared with the teams you choose. Generated PowerPoints remain private to their creator.</p>
<div class="field"><label for="name">Template name</label><input id="name" required maxlength="100" placeholder="e.g. Team presentation template" autocomplete="off"></div>
<div class="field"><label id="owner-label" for="owner-trigger">Owner team</label>${pickerMarkup('owner', 'owner teams', 'Choose an owner team')}<input id="team" type="hidden"><p class="hint">Choose a team you administer. Its members can use this template.</p></div>
<div class="field"><label for="file">PowerPoint template</label><label class="file-choice" for="file">${svg('file')}<div><strong id="file-label">Choose a .pptx file</strong><span id="file-hint">Empty template · up to 8 MiB</span></div></label><input class="visually-hidden" id="file" type="file" accept=".pptx" required><p class="hint">Use your team’s empty template with its original layouts. Remove example slides before uploading.</p></div>
<div class="field"><label id="share-label" for="share-trigger">Share with additional teams <span class="muted">(optional)</span></label>${pickerMarkup('share', 'additional teams', 'Choose teams to share with', true)}<div id="sharing" class="selected-teams"></div><p class="hint">Add up to 30 teams. Members of the owner team already have access.</p></div>
<p id="upload-message" class="form-message" role="status" aria-live="polite"></p></div><div class="dialog-actions"><button class="button" id="cancel-upload" type="button">Cancel</button><button class="button primary" id="submit" type="submit">Upload template</button></div></form></dialog>
</main><script src="${escapeHtml(basePath)}/client.js" defer></script></body></html>`;
}

export const clientScript = [readHostAppearance, normalizeTeamText, rankTeams, teamLabel, teamDescription, createSearchablePicker].map(fn => fn.toString()).join(';\n') + ';' + String.raw`
const base = document.body.dataset.base;
const byId = id => document.getElementById(id);
const configState = { teams: [], profiles: [], artifact_days: 7 };
let artifacts = [], templates = [], busy = false, deleting = null, deletingBusy = false;
const sharedTeams = new Set();
const iconPaths = ${JSON.stringify(paths)};
function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) node.setAttribute(key,value);
  const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',iconPaths[name]); node.append(path); return node;
}
function element(tag, className, text) { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text; return node; }
function status(text, kind='info') { byId('message').textContent=text; byId('message').dataset.kind=kind; }
window.addEventListener('message',event=>{
  const appearance=readHostAppearance(event,window.location.origin,window.parent);
  if (!appearance) return;
  if (appearance.theme) document.documentElement.dataset.theme=appearance.theme;
  if (appearance.shadows!==undefined) document.documentElement.dataset.interfaceShadows=appearance.shadows?'on':'off';
});
if(window.parent!==window) window.parent.postMessage({type:'caipe.microfrontend.ready.v1',version:'1.0',appId:'presentations'},window.location.origin);
async function api(path, options) {
  const response=await fetch(base+path,options);
  if(response.status===401)throw new Error('Please reload the app and sign in again.');
  let result;try {result=await response.json();}catch{throw new Error('The service is temporarily unavailable. Try refreshing.');}
  if(!response.ok)throw new Error(result.error||'The request could not be completed.');
  return result;
}
function badge(text,kind) { const node=element('span','badge'+(kind?' '+kind:'')); if(kind==='default')node.append(icon('check')); node.append(document.createTextNode(text)); return node; }
function date(value) { if(value==null)return null; const d=new Date(value); return Number.isFinite(d.getTime())?d:null; }
function formatDate(value) { return date(value)?.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})||'Unavailable'; }
function empty(container,heading,description,action=false) {
  const box=element('div','empty');const mark=element('div','empty-icon');mark.append(icon('file'));box.append(mark,element('h3','',heading),element('p','muted',description));
  if(action){const link=element('a','button primary','Open chat');link.href='/chat';link.target='_top';link.append(icon('arrow'));box.append(link);}
  container.replaceChildren(box);
}
function renderArtifacts() {
  const list=byId('artifacts');list.setAttribute('aria-busy','false');
  const query=byId('search').value.trim().toLowerCase();
  const all=artifacts.filter(item=>item.kept||date(item.expires_at)>new Date());
  const latest=[...all].sort((a,b)=>(date(b.created_at)?.getTime()||0)-(date(a.created_at)?.getTime()||0))[0]?.id;
  const matches=all.filter(item=>[item.title,item.filename].filter(Boolean).join(' ').toLowerCase().includes(query));
  const mode=byId('sort').value;
  matches.sort((a,b)=>mode==='name'?(a.title||a.filename).localeCompare(b.title||b.filename):mode==='expiry'?(date(a.expires_at)?.getTime()??Infinity)-(date(b.expires_at)?.getTime()??Infinity):(date(b.created_at)?.getTime()||0)-(date(a.created_at)?.getTime()||0));
  byId('deck-count').textContent=query?matches.length+' / '+all.length:String(all.length);
  if(!matches.length){empty(list,query?'No matching PowerPoints':'Your next PowerPoint starts in chat',query?'Try another title or clear your search.':'Ask an agent to create a presentation. Only your generated PowerPoints appear here.',!query);return;}
  list.replaceChildren();
  for(const artifact of matches) {
    const row=element('article','deck-row');const mark=element('div','file-icon');mark.append(icon('file'));
    const info=element('div','deck-info');const title=element('div','deck-title');const heading=element('h3','',artifact.title||artifact.filename);heading.title=artifact.filename;title.append(heading);if(artifact.id===latest)title.append(badge('Latest'));
    const meta=element('div','deck-meta');meta.append(badge('PPTX'));
    if(artifact.created_at){const created=element('time','', 'Created '+formatDate(artifact.created_at));created.dateTime=artifact.created_at;created.title=date(artifact.created_at)?.toLocaleString()||'';meta.append(created);}
    if(artifact.kept)meta.append(element('span','','Kept · no auto-delete'));
    else {const days=Math.max(1,Math.ceil((date(artifact.expires_at)-new Date())/86400000));
      const expiry=element('time','', 'Auto-deletes in '+days+(days===1?' day':' days'));expiry.dateTime=artifact.expires_at;expiry.title='Available until '+(date(artifact.expires_at)?.toLocaleString()||'');meta.append(expiry);}
    info.append(title,meta);
    const download=element('a','button download');download.href=artifact.download_url;download.setAttribute('aria-label','Download '+(artifact.title||artifact.filename));download.append(icon('download'),document.createTextNode('Download'));
    const actions=element('div','deck-actions');
    const keep=element('button','button'+(artifact.kept?' kept':''));keep.type='button';keep.setAttribute('aria-pressed',String(Boolean(artifact.kept)));keep.setAttribute('aria-label',(artifact.kept?'Resume auto-delete for ':'Keep ')+(artifact.title||artifact.filename));keep.title=artifact.kept?'Resume auto-delete':'Keep until you delete it';keep.append(icon(artifact.kept?'check':'bookmark'),document.createTextNode(artifact.kept?'Kept':'Keep'));
    keep.addEventListener('click',async()=>{keep.disabled=true;try {const updated=await api('/api/artifacts/'+artifact.id+'/retention',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({keep:!artifact.kept})});artifacts=artifacts.map(item=>item.id===artifact.id?updated:item);renderArtifacts();status(updated.kept?'PowerPoint kept. It will stay here until you delete it.':'Auto-delete resumed. This PowerPoint will be removed in '+configState.artifact_days+' days.');}catch(error){status(error.message,'error');keep.disabled=false;}});
    const remove=element('button','button icon-only ghost danger');remove.type='button';remove.setAttribute('aria-label','Delete '+(artifact.title||artifact.filename));remove.title='Delete PowerPoint';remove.append(icon('trash'));remove.addEventListener('click',()=>{deleting=artifact;byId('delete-description').textContent='Delete “'+(artifact.title||artifact.filename)+'”?';byId('delete-message').textContent='';byId('delete-dialog').showModal();});
    actions.append(download,keep,remove);row.append(mark,info,actions);list.append(row);
  }
}
function renderTemplates() {
  const list=byId('templates');list.replaceChildren();list.setAttribute('aria-busy','false');
  for(const template of templates) {
    const item=element('div','template');const title=element('div','template-title');title.append(element('h3','',template.name));if(template.is_default)title.append(badge('Default','default'));
    const owner=element('p','muted small template-owner',template.owner_team);const chips=element('div','chips');
    for(const mode of template.modes)chips.append(element('span','chip',mode.charAt(0).toUpperCase()+mode.slice(1)));
    item.append(title,owner,chips);list.append(item);
  }
  if(!templates.length)list.append(element('div','template muted','No templates are shared with your teams yet. Ask a team administrator to add one.'));
}
function renderSharing() {
  const list=byId('sharing');list.replaceChildren();
  for(const slug of sharedTeams) {
    const team=configState.teams.find(item=>item.slug===slug);const chip=element('span','selected-team',team?teamLabel(team):slug);chip.title=slug;const remove=element('button');remove.type='button';remove.setAttribute('aria-label','Remove '+slug);remove.append(icon('close'));remove.addEventListener('click',()=>{sharedTeams.delete(slug);renderSharing();sharePicker.update();});chip.append(remove);list.append(chip);
  }
}
function resetForm() {
  byId('upload').reset();byId('team').value='';sharedTeams.clear();renderSharing();byId('upload-message').textContent='';byId('file-label').textContent='Choose a .pptx file';byId('file-hint').textContent='Empty template · up to 8 MiB';
  const owner=templates.find(template=>template.is_default)?.owner_team;
  const admins=configState.teams.filter(team=>team.role==='admin');
  if(admins.some(team=>team.slug===owner))byId('team').value=owner;else if(admins.length===1)byId('team').value=admins[0].slug;
  ownerPicker.update();sharePicker.update();
}
async function refresh() {
  const button=byId('refresh');button.disabled=true;status('');
  const results=await Promise.allSettled([api('/api/config'),api('/api/templates'),api('/api/artifacts')]);
  const errors=[];
  if(results[0].status==='fulfilled'){Object.assign(configState,results[0].value);byId('open-upload').hidden=!configState.teams.some(team=>team.role==='admin');}else errors.push(results[0].reason.message);
  if(results[1].status==='fulfilled'){templates=results[1].value.templates;renderTemplates();}else {byId('templates').setAttribute('aria-busy','false');byId('templates').replaceChildren(element('p','template muted','Templates could not be loaded. Refresh to try again.'));errors.push(results[1].reason.message);}
  if(results[2].status==='fulfilled'){artifacts=results[2].value.artifacts;renderArtifacts();}else {byId('artifacts').setAttribute('aria-busy','false');empty(byId('artifacts'),'PowerPoints could not be loaded','Refresh to try again.');byId('deck-count').textContent='—';errors.push(results[2].reason.message);}
  if(errors.length)status([...new Set(errors)].join(' '),'error');
  button.disabled=false;
}
byId('cancel-delete').addEventListener('click',()=>{if(!deletingBusy)byId('delete-dialog').close();});
byId('delete-dialog').addEventListener('cancel',event=>{if(deletingBusy)event.preventDefault();});
byId('confirm-delete').addEventListener('click',async()=>{
  if(!deleting||deletingBusy)return;deletingBusy=true;byId('confirm-delete').disabled=true;byId('cancel-delete').disabled=true;
  try {await api('/api/artifacts/'+deleting.id,{method:'DELETE'});artifacts=artifacts.filter(item=>item.id!==deleting.id);renderArtifacts();byId('delete-dialog').close();deleting=null;status('PowerPoint deleted. Its stored file and download link have been removed.');}
  catch(error){byId('delete-message').textContent=error.message;}finally{deletingBusy=false;byId('confirm-delete').disabled=false;byId('cancel-delete').disabled=false;}
});
byId('search').addEventListener('input',renderArtifacts);byId('sort').addEventListener('change',renderArtifacts);byId('refresh').addEventListener('click',refresh);
byId('open-upload').addEventListener('click',()=>{resetForm();byId('upload-dialog').showModal();});
for(const id of ['close-upload','cancel-upload'])byId(id).addEventListener('click',()=>{if(!busy){ownerPicker.close();sharePicker.close();byId('upload-dialog').close();}});
byId('upload-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
const ownerPicker=createSearchablePicker({
  root:byId('owner-picker'),
  getOptions:query=>rankTeams(configState.teams.filter(team=>team.role==='admin'),query,[byId('team').value]),
  getSelected:()=>[byId('team').value],
  getValueLabel:()=>{const team=configState.teams.find(team=>team.slug===byId('team').value);return team?teamLabel(team):'Choose an owner team';},
  onSelect:team=>{byId('team').value=team.slug;sharedTeams.delete(team.slug);renderSharing();sharePicker.update();},
});
const sharePicker=createSearchablePicker({
  root:byId('share-picker'),multiple:true,
  getOptions:query=>rankTeams(configState.teams.filter(team=>team.slug!==byId('team').value),query,[...sharedTeams]),
  getSelected:()=>[...sharedTeams],
  getValueLabel:()=>sharedTeams.size?sharedTeams.size+(sharedTeams.size===1?' team selected':' teams selected'):'Choose teams to share with',
  isDisabled:team=>sharedTeams.size>=30&&!sharedTeams.has(team.slug),
  onSelect:team=>{if(sharedTeams.has(team.slug))sharedTeams.delete(team.slug);else sharedTeams.add(team.slug);renderSharing();},
});
byId('file').addEventListener('change',()=>{
  const file=byId('file').files[0];byId('file-label').textContent=file?file.name:'Choose a .pptx file';byId('file-hint').textContent=file?(file.size/1048576).toFixed(1)+' MiB · PowerPoint template':'Empty template · up to 8 MiB';
});
byId('upload').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;const button=byId('submit');const owner=byId('team').value.trim();
  if(!configState.teams.some(team=>team.slug===owner&&team.role==='admin')){byId('upload-message').textContent='Choose an owner team that you administer.';ownerPicker.focus();return;}
  busy=true;button.disabled=true;byId('upload-message').textContent='Uploading template…';
  try{
    const file=byId('file').files[0];if(!file||!file.name.toLowerCase().endsWith('.pptx')||file.size>8*1024*1024)throw new Error('Choose a .pptx file no larger than 8 MiB.');
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let start=0;start<bytes.length;start+=32768)binary+=String.fromCharCode(...bytes.subarray(start,start+32768));
    await api('/api/templates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:byId('name').value,owner_team:owner,shared_with:[...sharedTeams].filter(team=>team!==owner),file:btoa(binary)})});
    byId('upload-dialog').close();await refresh();status('Team template uploaded. It is available to its owner team and the teams you selected.');
  }catch(error){byId('upload-message').textContent=error.message;}finally{busy=false;button.disabled=false;}
});
refresh().catch(error=>status(error.message,'error'));
`;
