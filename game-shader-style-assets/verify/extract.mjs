// Pull every <!-- sample:NAME --> fenced block out of the doc, verbatim.
import fs from 'node:fs';
const md = fs.readFileSync(process.argv[2], 'utf8');
const re = /<!-- sample:([\w.]+) -->\s*```\w*\n([\s\S]*?)```/g;
const out = {}; let m;
while ((m = re.exec(md))) out[m[1]] = m[2];
fs.mkdirSync(process.argv[3], { recursive: true });
for (const [k, v] of Object.entries(out)) fs.writeFileSync(`${process.argv[3]}/${k}`, v);
fs.writeFileSync(`${process.argv[3]}/glsl.js`, 'export default ' + JSON.stringify(Object.fromEntries(Object.entries(out).filter(([k]) => !k.endsWith('.js')))) + ';\n');
console.log(Object.keys(out).join(' '));
