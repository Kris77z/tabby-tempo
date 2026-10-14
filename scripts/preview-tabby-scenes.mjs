/** Local-only, read-only scene gallery; never connects to a hosted executor. */
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(root,'demo-output/tabby-scenes');
await mkdir(out,{recursive:true});
await build({entryPoints:[resolve(root,'frontend/preview/tabby-scenes/entry.tsx')],bundle:true,outfile:resolve(out,'entry.js'),jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},minify:true});
if(process.argv.includes('--build-only'))process.exit(0);
const files=new Map([
 ['/',[resolve(root,'frontend/preview/tabby-scenes/index.html'),'text/html; charset=utf-8']],
 ['/entry.js',[resolve(out,'entry.js'),'text/javascript; charset=utf-8']],
 ['/entry.css',[resolve(out,'entry.css'),'text/css; charset=utf-8']],
]);
createServer(async(req,res)=>{
 const file=files.get(req.url??'');if(!file){res.writeHead(404).end();return;}
 try{res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store'});res.end(await readFile(file[0]));}
 catch{res.writeHead(500).end('Preview unavailable');}
}).listen(3032,'127.0.0.1',()=>console.log('Tabby scene gallery: http://localhost:3032/'));
