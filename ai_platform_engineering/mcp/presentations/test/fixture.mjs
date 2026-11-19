import JSZip from 'jszip';
export const profile = { modes: { primary: { master: 1, cover: 1, content: 2, closing: 3, open_items: 4 } },
  placeholders: { title: '0', subtitle: '1', eyebrow: '13', status: '16', items: ['20', '21'], owners: ['30', '31'], due: ['40', '41'] },
  canvas: [.67, 1.95, 11.9, 3.6], footer_y: 6.05, font: 'Arial' };
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export async function template() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master1"/></p:sldMasterIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="master1" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>`);
  zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster xmlns:p="${P}" xmlns:a="${A}"><p:cSld name="Example master"><p:spTree/></p:cSld></p:sldMaster>`);
  for (let i = 1; i <= 4; i++) {
    const shapes = [0, 1, 13, 16, 20, 21, 30, 31, 40, 41].map((idx, n) => `<p:sp><p:nvSpPr><p:cNvPr id="${n + 2}" name="Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph idx="${idx}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Click to edit</a:t></a:r></a:p></p:txBody></p:sp>`).join('');
    zip.file(`ppt/slideLayouts/slideLayout${i}.xml`, `<p:sldLayout xmlns:p="${P}" xmlns:a="${A}"><p:cSld name="Example layout ${i}"><p:spTree>${shapes}</p:spTree></p:cSld></p:sldLayout>`);
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
