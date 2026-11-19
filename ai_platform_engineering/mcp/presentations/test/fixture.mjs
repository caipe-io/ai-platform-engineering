import JSZip from 'jszip';
export const profile = { modes: { primary: { master: 1, cover: 1, content: 2, closing: 3, open_items: 4 } },
  placeholders: { title: '0', subtitle: '1', eyebrow: '13', status: '16', items: ['20', '21'], owners: ['30', '31'], due: ['40', '41'] },
  canvas: [.67, 1.95, 11.9, 3.6], footer_y: 6.05, font: 'Arial' };
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
const COLOR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
export async function template() {
  const zip = new JSZip();
  const override = (path, kind) => `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.${kind}+xml"/>`;
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${override('ppt/presentation.xml', 'presentationml.presentation.main')}${override('ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster')}${override('ppt/theme/theme1.xml', 'theme')}${[1,2,3,4].map(i => override(`ppt/slideLayouts/slideLayout${i}.xml`, 'presentationml.slideLayout')).join('')}</Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master1"/></p:sldMasterIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="master1" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>`);
  zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld name="Example master"><p:spTree>${GROUP}</p:spTree></p:cSld>${COLOR_MAP}<p:sldLayoutIdLst>${[1,2,3,4].map(i => `<p:sldLayoutId id="${2147483648+i}" r:id="layout${i}"/>`).join('')}</p:sldLayoutIdLst></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="theme" Type="${R}/theme" Target="../theme/theme1.xml"/>${[1,2,3,4].map(i => `<Relationship Id="layout${i}" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout${i}.xml"/>`).join('')}</Relationships>`);
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const colors = { dk1:'111111',lt1:'FFFFFF',dk2:'333333',lt2:'EEEEEE',accent1:'0066AA',accent2:'228844',accent3:'8855AA',accent4:'CC6600',accent5:'777777',accent6:'CCAA00',hlink:'0066AA',folHlink:'8855AA' };
  const font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';
  zip.file('ppt/theme/theme1.xml', `<a:theme xmlns:a="${A}" name="Example"><a:themeElements><a:clrScheme name="Example">${Object.entries(colors).map(([name,value])=>`<a:${name}><a:srgbClr val="${value}"/></a:${name}>`).join('')}</a:clrScheme><a:fontScheme name="Example"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme><a:fmtScheme name="Example"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${`<a:ln w="12700">${fill}<a:prstDash val="solid"/></a:ln>`.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  for (let i = 1; i <= 4; i++) {
    const shapes = [0, 1, 13, 16, 20, 21, 30, 31, 40, 41].map((idx, n) => `<p:sp><p:nvSpPr><p:cNvPr id="${n + 2}" name="Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph idx="${idx}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Click to edit</a:t></a:r></a:p></p:txBody></p:sp>`).join('');
    zip.file(`ppt/slideLayouts/slideLayout${i}.xml`, `<p:sldLayout xmlns:p="${P}" xmlns:a="${A}"><p:cSld name="Example layout ${i}"><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld></p:sldLayout>`);
    zip.file(`ppt/slideLayouts/_rels/slideLayout${i}.xml.rels`, `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="master" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  }
  return zip;
}
export const deck = { title: 'Example briefing', mode: 'primary', slides: [
  { kind: 'cover', title: 'Example briefing', subtitle: 'A review copy' },
  { title: 'A sourced result', bullets: [{ text: 'A fixture marker survives export', sources: ['https://example.test/evidence'] }], notes: 'A source-backed fixture.' },
  { kind: 'closing', title: 'Review the result' },
] };
export const member = { subject: 'example-user', teams: new Map([['example-team', { name: 'Example team', role: 'member' }]]) };
export const admin = { ...member, teams: new Map([['example-team', { name: 'Example team', role: 'admin' }]]) };

export const visualDeck = { ...deck, title: 'Evidence composition fixtures', slides: [
  { kind: 'cover', title: 'Evidence composition fixtures', subtitle: 'Synthetic layout checks' },
  ...['metrics', 'comparison', 'flow', 'timeline', 'layers', 'ledger'].map(layout => ({
    title: `Example ${layout}`, notes: 'Synthetic fixture values, not operational claims.',
    visual: { layout, groups: (layout === 'comparison' ? ['Primary', 'Secondary'] : ['First', 'Second', 'Third']).map((label, i) => ({
      label, ...(layout === 'metrics' ? { value: String((i + 1) * 12) } : {}),
      items: ['Example evidence'], sources: ['https://example.test/evidence'],
    })) },
  })),
  { kind: 'closing', title: 'Review the evidence' },
] };
