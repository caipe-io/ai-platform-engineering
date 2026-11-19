const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
export function page(basePath) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Presentations</title>
<style>body{font:16px system-ui,sans-serif;background:#101217;color:#edf0f5;margin:0}main{max-width:1000px;margin:auto;padding:36px 24px}h1{font-size:36px;font-weight:500;margin-bottom:8px}h2{font-size:22px;font-weight:500}p{color:#aeb8c8;line-height:1.6}.columns{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{border:1px solid #354052;border-radius:12px;padding:24px;margin-top:24px}label,legend{display:block;margin:18px 0 8px}input,select,button{box-sizing:border-box;padding:12px;border:1px solid #536176;border-radius:6px;background:#191e29;color:inherit;font:inherit;max-width:100%}input,select{width:100%}input[type=checkbox]{width:auto;margin-right:8px}button{background:#92d9eb;color:#101217;border:0;cursor:pointer;margin-top:20px}button:disabled{opacity:.5;cursor:default}a{color:#92d9eb}.item{padding:16px 0;border-bottom:1px solid #354052}.muted{font-size:14px;color:#aeb8c8}#message{min-height:28px}fieldset{border:0;padding:0}summary{cursor:pointer}details label{font-size:14px}:focus-visible{outline:3px solid #92d9eb;outline-offset:3px}@media(max-width:760px){.columns{grid-template-columns:1fr}main{padding:24px 16px}}</style>
<body data-base="${escapeHtml(basePath)}"><main><h1>Presentations</h1><p>Manage private team templates and download decks created by your agents.</p><p id="message" role="status" aria-live="polite"></p><div class="columns"><section><h2>Upload a template</h2><p class="muted">Use an empty .pptx with the layouts supplied by your template owner. Files stay private.</p><form id="upload"><label for="name">Template name</label><input id="name" required maxlength="100"><label for="team">Owner team</label><select id="team" required></select><label for="preset">Template preset</label><select id="preset" required></select><label for="file">PowerPoint template</label><input id="file" type="file" accept=".pptx" required><p class="muted">Up to 8 MiB. Remove example slides first.</p><details><summary>Share with additional teams</summary><fieldset id="sharing"><legend>Additional teams</legend></fieldset></details><button id="submit" type="submit">Upload template</button></form></section><section><h2>Available templates</h2><div id="templates">Loading…</div></section></div><section><h2>Your recent decks</h2><p class="muted">Downloads require your current sign-in and template access. Files expire after seven days.</p><div id="artifacts">Loading…</div></section></main><script src="${escapeHtml(basePath)}/client.js" defer></script></body></html>`;
}
export const clientScript = `
const base = document.body.dataset.base;
const message = document.querySelector('#message');
async function api(path, options) {
  const response = await fetch(base + path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function option(value, text) { const node = document.createElement('option'); node.value=value; node.textContent=text; return node; }
async function refresh() {
  const [config, templates, artifacts] = await Promise.all([api('/api/config'), api('/api/templates'), api('/api/artifacts')]);
  const team = document.querySelector('#team'); team.replaceChildren();
  for (const item of config.teams.filter(item => item.role === 'admin')) team.append(option(item.slug,item.name));
  const preset = document.querySelector('#preset'); preset.replaceChildren();
  for (const item of config.profiles) preset.append(option(item.id,item.name));
  const sharing = document.querySelector('#sharing'); sharing.replaceChildren();
  for (const item of config.teams) {
    const label = document.createElement('label'); const input = document.createElement('input'); input.type='checkbox'; input.value=item.slug;
    label.append(input,document.createTextNode(item.name)); sharing.append(label);
  }
  document.querySelector('#submit').disabled = !team.options.length || !preset.options.length;
  if (!team.options.length) message.textContent = 'Ask a team administrator to upload templates. You can use templates already shared with your teams.';
  const list = document.querySelector('#templates'); list.replaceChildren();
  for (const template of templates.templates) {
    const item=document.createElement('div'); item.className='item'; const name=document.createElement('strong'); name.textContent=template.name;
    const info=document.createElement('p'); info.className='muted'; info.textContent=template.owner_team+' · '+template.modes.join(', ');
    item.append(name,info); list.append(item);
  }
  if (!list.children.length) list.textContent='No templates are available to your teams yet.';
  const recent=document.querySelector('#artifacts'); recent.replaceChildren();
  for (const artifact of artifacts.artifacts) {
    const item=document.createElement('div'); item.className='item'; const link=document.createElement('a'); link.href=artifact.download_url; link.textContent=artifact.filename;
    const expiry=document.createElement('p'); expiry.className='muted'; expiry.textContent='Expires '+new Date(artifact.expires_at).toLocaleString(); item.append(link,expiry); recent.append(item);
  }
  if (!recent.children.length) recent.textContent='Ask an agent with presentation tools to create a deck. Your downloads will appear here.';
}
document.querySelector('#upload').addEventListener('submit',async event => {
  event.preventDefault(); const button=document.querySelector('#submit'); button.disabled=true; message.textContent='Uploading template…';
  try {
    const file=document.querySelector('#file').files[0]; if (!file || file.size > 8*1024*1024) throw new Error('Choose a .pptx no larger than 8 MiB');
    const bytes=new Uint8Array(await file.arrayBuffer()); let binary=''; for(let start=0;start<bytes.length;start+=32768) binary+=String.fromCharCode(...bytes.subarray(start,start+32768));
    await api('/api/templates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      name:document.querySelector('#name').value,owner_team:document.querySelector('#team').value,profile_id:document.querySelector('#preset').value,
      shared_with:[...document.querySelectorAll('#sharing input:checked')].map(input=>input.value),file:btoa(binary),
    })}); document.querySelector('#upload').reset(); await refresh(); message.textContent='Private template uploaded.';
  } catch(error) { message.textContent=error.message; } finally {button.disabled=false;}
});
refresh().catch(error=>{message.textContent=error.message;});
`;
