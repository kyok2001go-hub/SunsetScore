import path from 'node:path';
import vm from 'node:vm';
import {readFile,writeFile,mkdir,copyFile,realpath} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {hash,canonicalJson,fail,inventory} from '../dataset/lib/common.mjs';
import {APP_ROOT,loadPool,checkInputs,codeIdentity} from '../practical-tuning/data.mjs';
import {inspectPractical} from '../practical-tuning/workflow.mjs';
import {weightedRows} from '../product-evaluation/metrics.mjs';
import {highCloudMetrics} from '../practical-tuning/high-cloud.mjs';
import {digest} from '../practical-tuning/policy.mjs';
import {runReplay} from '../replay/replay-runner.mjs';
import {scoreToOrdinal} from '../evaluation/metrics.mjs';
export const SOURCE_RUN='practical_tuning_v6_7afed8a39cb7ddfc8d4c';
export const SOURCE_CONFIG_SHA='bd2a552acbd4ef9ab304208cbdc0d3cac8036c273a1d39e6732fe057e92f0766';
export const RELEASE_VALUES=Object.freeze({'weights.skyCanvas':.2,'weights.horizon':.375,'weights.illumination':.4,'weights.atmosphere':.025,'weights.weather':0,midCloudCenter:54,midCloudWidth:34,'goldenWindow.floor':.507692307692});
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const at=(o,p)=>p.split('.').reduce((v,k)=>v?.[k],o);
export function differences(a,b,prefix='') {
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)||a==null&&b&&typeof b==='object'&&!Array.isArray(b))
    return [...new Set([...Object.keys(a??{}),...Object.keys(b??{})])].sort().flatMap(k=>differences(a?.[k],b?.[k],prefix?`${prefix}.${k}`:k));
  return canonicalJson(a)===canonicalJson(b)?[]:[{path:prefix,source:a??null,runtime:b??null}];
}
export async function loadProduction(root=APP_ROOT) {
  const context=vm.createContext({console,Date,Math,JSON,Number,Object,Array,TextEncoder,Uint8Array,crypto:webcrypto});
  for(const file of ['js/config.js','js/model_config.js','js/time.js','js/cloud_field.js','js/replay_service.js'])vm.runInContext(await readFile(path.join(root,file),'utf8'),context,{filename:file,timeout:2000});
  const SS=context.SunsetScore,m=SS.modelConfig,c=SS.config;
  if(m.scoring!==c||m.goldenWindow!==c.goldenWindow||m.skyState!==c.skyState||m.evolution!==c.evolution||m.nowcast!==c.nowcast)fail('RELEASE_ALIAS_MISMATCH');
  return {SS,model:m,scoring:JSON.parse(JSON.stringify(c)),version:JSON.parse(JSON.stringify(SS.version)),runtime_config_key:SS.modelConfigKey()};
}
export function compareSelected(source,runtime) {
  const d=differences(source,runtime),allowed={version:['2.4.6','2.5.5.0'],'illuminationModel.bankShare':[null,.5],'illuminationModel.twilightSaturationMinutes':[null,35],'skyState.factorCoefficients.arrivalRiskSlope':[null,.3]};
  if(d.length!==4||d.some(v=>!allowed[v.path]||digest([v.source,v.runtime])!==digest(allowed[v.path])))fail('UNEXPECTED_RELEASE_CONFIG_DIFFERENCE');
  for(const [p,v]of Object.entries(RELEASE_VALUES))if(at(runtime,p)!==v)fail('RELEASE_PARAMETER_MISMATCH');
  return d.map(v=>({...v,reason:v.path==='version'?'EXPLICIT_MODEL_IDENTITY_CHANGE':'ALREADY_PROVED_DEFAULT_EQUIVALENT_FIELD'}));
}
// Use the real capture serializer to obtain its configuration scope. This local
// probe is not a weather query or a Snapshot and is never submitted anywhere.
export async function captureEffective(SS) {
  const now=Date.parse('2026-08-26T17:00:00Z'),sunset=new Date(now+3600000),point={key:'CONFIG_PROBE',direction:'CENTER',distanceKm:0,azimuthOffset:0,azimuth:270,latitude:0,longitude:0,weight:1};
  const capture=await SS.replayService.capture({result:{prediction_time_utc:new Date(now).toISOString(),model_version:SS.version.model,city:'CONFIG_PROBE',country:'TEST',latitude:0,longitude:0,timezone:'UTC',utc_offset_seconds:0},
    context:{time:{nowUtcMs:now,sunsetUtcMs:sunset.valueOf()},solar:{sunset,civilDusk:new Date(+sunset+35*60000),sunsetAzimuthDeg:270,twilightMinutes:35},nowcast:{}},
    spatial:{skySamples:[{point,forecast:{timezone:'UTC',utc_offset_seconds:0,hourly:{time:['2026-08-26T17:00','2026-08-26T18:00'],cloud_cover:[50,50],cloud_cover_high:[50,50],cloud_cover_mid:[50,50],cloud_cover_low:[20,20]}}}],corridorSamples:[],finalMode:'LOCAL_ONLY',cacheStatus:'MISS',ageMinutes:0},engineInput:{expectedSampleCount:1,spatialCompleteness:1}});
  if(hash(canonicalJson(capture.effective_config))!==capture.identity.config_hash)fail('RELEASE_EFFECTIVE_CONFIG_HASH_MISMATCH');
  return {effective_config:capture.effective_config,config_hash:capture.identity.config_hash,scope:'ACTUAL_REPLAY_CAPTURE_SERIALIZER_CONFIGURATION_ONLY_PROBE'};
}
export const RUNTIME_DIRS=Object.freeze(['admin','css','js','functions','server']);
export async function safeOutput(output,root=APP_ROOT) {
  const resolved=path.resolve(output),app=await realpath(root);
  // Resolve the nearest existing ancestor to catch junctions as well as traversal.
  let parent=resolved,suffix=[];
  while(true){try{parent=await realpath(parent);break;}catch(e){if(e.code!=='ENOENT')throw e;const next=path.dirname(parent);if(next===parent)throw e;suffix.unshift(path.basename(parent));parent=next;}}
  const target=path.join(parent,...suffix),inside=(base,child)=>{const rel=path.relative(base,child);return !rel||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
  if(inside(app,target)||inside(target,app))fail('RELEASE_OUTPUT_OVERLAPS_APP');
  return target;
}
export async function stageRuntime(output,root=APP_ROOT) {
  output=await safeOutput(output,root);
  const files={};const list=['index.html','_headers','package.json','package-lock.json'];
  for(const dir of RUNTIME_DIRS)for(const name of await inventory(path.join(root,dir)))list.push(`${dir}/${name}`);
  try{if((await inventory(output)).some(rel=>!list.includes(rel)))fail('RELEASE_ARTIFACT_HAS_UNEXPECTED_FILES');}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const rel of list){if(/(?:^|\/)(?:\.env|\.dev\.vars|QweatherKey)|\.(?:pem|key)$/i.test(rel))fail('RELEASE_SECRET_FILE_FORBIDDEN');
    const bytes=await readFile(path.join(root,rel)),dest=path.join(output,rel);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,bytes);files[rel]=hash(bytes);}
  // Resolve every local Functions/server import inside the staged runtime.
  for(const rel of list.filter(r=>/^(?:functions|server)\/.*\.js$/.test(r))){const src=(await readFile(path.join(root,rel),'utf8'));for(const match of src.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){
    if(match[1].startsWith('.')){const target=path.posix.normalize(path.posix.join(path.posix.dirname(rel),match[1]));if(!files[target])fail('RELEASE_RUNTIME_IMPORT_MISSING');}
    else if(match[1]!=='jose')fail('RELEASE_UNKNOWN_RUNTIME_DEPENDENCY');}}
  return {scope:'EXPLICIT_RUNTIME_ALLOWLIST_WITH_FUNCTIONS_AND_SERVER_DEPENDENCIES',files,artifact_sha256:digest(files),uncommitted_review_required:true};
}
export async function prepareRelease(output,{progress=()=>{}}={}) {
  output=await safeOutput(output);const source=path.join(APP_ROOT,'dataset/practical_tuning',SOURCE_RUN),code=await codeIdentity();
  const inspected=await inspectPractical(source),selectedBytes=await readFile(path.join(source,'selected_effective_config.json'));
  if(hash(selectedBytes)!==SOURCE_CONFIG_SHA||inspected.result.selected_candidate!=='practical_candidate_v6_34df8f13f05d6275e49d')fail('RELEASE_SOURCE_IDENTITY_MISMATCH');
  const selected=JSON.parse(selectedBytes),request=await json(path.join(source,'verification_request.json')),production=await loadProduction();
  if(production.version.model!=='2.5.5.0'||production.version.app!=='2.4.6'||production.version.assetRevision!=='model2550'||production.scoring.version!=='2.5.5.0')fail('RELEASE_VERSION_MISMATCH');
  const configDiff=compareSelected(selected,production.scoring),effective=await captureEffective(production.SS),loaded=await loadPool(inspected.spec.sources,progress);
  if(digest(loaded.fingerprints)!==digest(inspected.spec.identity.inputs)||loaded.exclusions.length)fail('RELEASE_INPUT_MISMATCH');
  const byId=new Map(loaded.rows.map(r=>[r.snapshot_id,r])),rows=weightedRows(request.pool.included.map(r=>{const live=byId.get(r.snapshot_id);if(!live||['event_id','gt_ordinal','gt_confidence','input_sha256'].some(k=>r[k]!==live[k]))fail('RELEASE_MEMBER_MISMATCH');return live;}));
  if(rows.length!==655||byId.size!==655||rows.some((r,i)=>r.event_normalized_weight!==request.pool.included[i].event_normalized_weight))fail('RELEASE_POOL_MISMATCH');
  const scores=[],records=[];
  for(const [i,row]of rows.entries()){
    const result=await runReplay(row.replay,{modelConfig:production.model}),score=result.actual.score,ordinal=scoreToOrdinal(score),expected=request.selected.scores[i];
    if(score!==expected||ordinal!==scoreToOrdinal(expected))fail('RELEASE_PREDICTION_DIFFERS');
    scores.push(score);records.push({snapshot_id:row.snapshot_id,event_id:row.event_id,gt_ordinal:row.gt_ordinal,event_weight:row.event_normalized_weight,source_score:expected,release_score:score,source_ordinal:scoreToOrdinal(expected),release_ordinal:ordinal});
    if((i+1)%100===0||i+1===rows.length)progress(`发布一致性 ${i+1}/${rows.length}：整数分数与等级完全相同`);
  }
  const metrics=highCloudMetrics(rows,scores);if(digest(metrics)!==digest(request.selected.metrics))fail('RELEASE_METRICS_DIFFERS');
  await checkInputs(loaded);if((await codeIdentity()).sha256!==code.sha256)fail('CODE_CHANGED_DURING_RELEASE');
  await mkdir(output,{recursive:true});const put=async(n,v)=>writeFile(path.join(output,n),canonicalJson(v)+'\n');
  const legacy=await json(path.join(source,'original_control_config.json'));
  const diff={parameter_changes:Object.entries(RELEASE_VALUES).map(([p,v])=>({path:p,experiment_B0:at(legacy,p),release:v})),candidate_runtime_differences:configDiff,
    unchanged:{highCloudCenter:60,highCloudWidth:25,minimumWeatherWeight:.05,illuminationModel:{bankShare:.5,twilightSaturationMinutes:35},arrivalRiskSlope:.3},new_default_is_not_old_default:true};
  const comparison={status:'PASS',scope:'RELEASE_CONSISTENCY_ON_REUSED_DEVELOPMENT_DATA; NOT_INDEPENDENT_TEST',snapshot_count:655,event_count:metrics.event_count,date_count:metrics.date_count,
    source_metrics:request.selected.metrics,release_metrics:metrics,exact_score_and_ordinal_equal:true,metrics_equal:true,full_search_repeated:false,
    source_config_file_sha256:SOURCE_CONFIG_SHA,runtime_scoring_config_sha256:hash(canonicalJson(production.scoring)),replay_effective_config_sha256:effective.config_hash,
    prediction_signature_sha256:digest(rows.map((r,i)=>[r.snapshot_id,scores[i],scoreToOrdinal(scores[i])])),source_prediction_signature_sha256:request.selected.predictions_sha256};
  await copyFile(path.join(source,'selected_effective_config.json'),path.join(output,'source_selected_effective_config.json'));
  await put('parameter_diff.json',diff);await put('release_comparison.json',comparison);await put('runtime_scoring_config.json',production.scoring);await put('replay_effective_config.json',effective);
  const headers=Object.keys(records[0]);await writeFile(path.join(output,'release_predictions.csv'),headers.join(',')+'\r\n'+records.map(r=>headers.map(k=>String(r[k])).join(',')).join('\r\n')+'\r\n');
  await put('release_code_identity.json',code);await put('source_provenance.json',{run_id:SOURCE_RUN,candidate_id:inspected.result.selected_candidate,manifest_sha256:hash(await readFile(path.join(source,'manifest.json'))),
    selected_file_sha256:SOURCE_CONFIG_SHA,pool_manifest_file_sha256:hash(await readFile(path.join(source,'pool_manifest.json'))),pool_members_sha256:digest(request.pool.included),source_ids:request.pool.source_ids,
    selected_predictions_file_sha256:hash(await readFile(path.join(source,'selected_predictions.csv'))),source_metrics_sha256:digest(request.selected.metrics),source_inputs:inspected.spec.identity.inputs});
  const artifact=await stageRuntime(path.join(output,'release_artifact'));await put('release_artifact_manifest.json',artifact);
  return {status:'LOCAL_CONSISTENCY_PASS_PENDING_FULL_CHECK_AND_HISTORICAL_VERIFY',source_run:SOURCE_RUN,output,snapshots:655,scoring_hash:comparison.runtime_scoring_config_sha256,effective_config_hash:effective.config_hash,artifact_sha256:artifact.artifact_sha256};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv[2]!=='prepare'||!process.argv[3])fail('USAGE_PREPARE_OUTPUT');console.log(canonicalJson(await prepareRelease(process.argv[3],{progress:console.error})));}
  catch(e){console.error(e.code??e.message);process.exitCode=1;}
}
