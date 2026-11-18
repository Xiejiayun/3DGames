import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';

const [modelDir, engineDir] = process.argv.slice(2);
if (!modelDir) throw Error('Usage: node scripts/pack-kart-html.mjs <GLB directory> [extracted three@0.186.1 package]');
const file = new URL('../games/kart.html', import.meta.url);
const html = await readFile(file, 'utf8');
const ids = ['sprint-27','frost','volt','coast','forest','alpine','items'];
if (modelDir==='--extract') {
  if(!engineDir) throw Error('Specify a new output directory for the models');
  await mkdir(engineDir);
  for(const id of ids) {
    const match=html.match(new RegExp(`id="kart-file-${id}">([^<]+)</script>`));
    if(!match) throw Error('Missing model: '+id);
    await writeFile(join(engineDir,id+'.glb'),gunzipSync(Buffer.from(match[1],'base64')),{flag:'wx'});
  }
  process.exit(0);
}
const block = /<!-- kart:embedded:start -->[\s\S]*?<!-- kart:embedded:end -->/;
if (!block.test(html)) throw Error('Missing kart payload delimiters');
const entries = [];
const pack = (id, bytes) => `<script type="application/octet-stream" id="kart-file-${id}">\n${gzipSync(bytes,{level:9}).toString('base64').match(/.{1,4096}/g).join('\n')}\n</script>`;
if (engineDir) {
  const dir=resolve(engineDir), manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
  if(manifest.name!=='three' || manifest.version!=='0.186.1') throw Error('Expected three@0.186.1');
  const {build}=await import('esbuild');
  const bundle=await build({stdin:{contents:`import * as THREE from 'three'; export {THREE}; export {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';`,resolveDir:dir},bundle:true,minify:true,write:false,format:'esm',platform:'browser',legalComments:'inline'});
  const license=await readFile(join(dir,'LICENSE'),'utf8');
  entries.push(`<!-- three@0.186.1\n${license.trim()}\n-->`,pack('engine',bundle.outputFiles[0].contents));
} else {
  const engine=html.match(/<!-- three@[^]*?<\/script>/);
  if(!engine) throw Error('The initial pack requires the engine package');
  entries.push(engine[0]);
}
for(const id of ids) {
  const bytes=await readFile(join(modelDir,id+'.glb'));
  if(bytes.toString('ascii',0,4)!=='glTF' || bytes.readUInt32LE(4)!==2 || bytes.readUInt32LE(8)!==bytes.length) throw Error('Invalid GLB: '+id);
  entries.push(pack(id,bytes));
}
await writeFile(file,html.replace(block,()=>['<!-- kart:embedded:start -->',...entries,'<!-- kart:embedded:end -->'].join('\n')));
