import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,mkdir,lstat,readdir,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const DIRECTORIES=['admin','css','js','functions','server'];
const ROOT_FILES=['index.html','_headers','package.json','package-lock.json'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

async function filesWithin(root,prefix='') {
  const files=[];
  for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){
    const rel=path.posix.join(prefix,entry.name),stat=await lstat(path.join(root,rel));
    if(stat.isSymbolicLink())throw Error('PAGES_STAGE_SYMLINK_FORBIDDEN');
    if(entry.isDirectory())files.push(...await filesWithin(root,rel));
    else if(stat.isFile()&&stat.nlink===1)files.push(rel);
    else throw Error('PAGES_STAGE_NON_REGULAR_FILE');
  }
  return files.sort();
}

// Fixed build destination. Never delete source, accept an arbitrary output path,
// or rely on .gitignore when deciding what becomes a public static asset.
export async function stagePages() {
  const root=await realpath(ROOT),output=path.join(root,'artifacts','pages');
  for(const segment of ['artifacts',path.join('artifacts','pages')]){
    try{if((await lstat(path.join(root,segment))).isSymbolicLink())throw Error('PAGES_STAGE_SYMLINK_FORBIDDEN');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const names=[...ROOT_FILES];
  for(const dir of DIRECTORIES){if((await lstat(path.join(root,dir))).isSymbolicLink())throw Error('PAGES_STAGE_SYMLINK_FORBIDDEN');for(const rel of await filesWithin(path.join(root,dir)))names.push(`${dir}/${rel}`);}
  const allowed=new Set(names);
  try{for(const rel of await filesWithin(output))if(!allowed.has(rel))throw Error('PAGES_STAGE_UNEXPECTED_OUTPUT_FILE');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  const hashes={};
  for(const rel of names.sort()){
    if(/(?:^|\/)(?:\.env|\.dev\.vars|QweatherKey)|\.(?:key|pem)$/i.test(rel))throw Error('PAGES_STAGE_SECRET_PATH_FORBIDDEN');
    const source=path.join(root,rel),stat=await lstat(source);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)throw Error('PAGES_STAGE_NON_REGULAR_FILE');
    const bytes=await readFile(source),destination=path.join(output,rel);
    await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes);hashes[rel]=sha(bytes);
  }
  return {status:'STAGED_ONLY_NOT_DEPLOYED',directory:output,files:hashes};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==2)throw Error('PAGES_STAGE_ACCEPTS_NO_ARGUMENTS');
  const result=await stagePages();console.log(JSON.stringify({status:result.status,directory:result.directory,file_count:Object.keys(result.files).length}));
}
