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
import {scoreToOrdinal,gradeScore,gradeThresholdsFromLevels,gradeThresholdsForModelVersion,LEGACY_GRADE_THRESHOLDS} from '../evaluation/metrics.mjs';
import {buildModelConfig} from '../tuning/lib/base-config.mjs';
export const SOURCE_RUN='practical_tuning_v6_7afed8a39cb7ddfc8d4c';
export const SOURCE_CONFIG_SHA='bd2a552acbd4ef9ab304208cbdc0d3cac8036c273a1d39e6732fe057e92f0766';
export const LEGACY_LEVELS=Object.freeze([{min:90,label:'极佳'},{min:60,label:'很好'},{min:40,label:'一般'},{min:20,label:'较差'},{min:0,label:'很差'}]);
export const V2552_LEVELS=Object.freeze([{min:90,label:'极佳'},{min:66,label:'很好'},{min:47,label:'一般'},{min:22,label:'较差'},{min:0,label:'很差'}]);
export const RELEASE_LEVELS=Object.freeze([{min:90,label:'极佳'},{min:66,label:'很好'},{min:49,label:'一般'},{min:19,label:'较差'},{min:0,label:'很差'}]);
export const RELEASE_VALUES=Object.freeze({'weights.skyCanvas':.2,'weights.horizon':.375,'weights.illumination':.4,'weights.atmosphere':.025,'weights.weather':0,midCloudCenter:54,midCloudWidth:34,'goldenWindow.floor':.507692307692,
  // V2.5.5.1: sky evolution disabled.
  'skyState.factorRange':[1,1],
  // V2.5.5.2: golden-window open thresholds, centred factor and grade lines.
  'evolution.openCoverageThreshold':35,'evolution.satelliteOpenThreshold':40,'goldenWindow.reference':.826654,levels:RELEASE_LEVELS,
  // V2.5.5.4: corridor-centre azimuth fix.
  'spatialField.centerAzimuthOffset':0});
// V2.5.5.7 / V2.5.5.8 change the app only (record-only bypass and satellite shadow capture); model and scoring configuration stay 2.5.5.4.
export const RELEASE_VERSION=Object.freeze({app:'2.5.5.11',model:'2.5.5.11',assetRevision:'app25511'});
// The previous release, rebuilt from production by removing the V2.5.5.4 key; it must reproduce V2552_REFERENCE.
export const V2552_VERSION='2.5.5.2';
export function v2552Scoring(scoring) {
  const base=scoring.version===RELEASE_VERSION.model?v2554Scoring(scoring):scoring;
  if(base.version!==CANDIDATE_VERSION||base.spatialField?.centerAzimuthOffset!==0)fail('RELEASE_V2552_BASE_MISMATCH');
  const previous=structuredClone(base);previous.version=V2552_VERSION;delete previous.spatialField.centerAzimuthOffset;
  return previous;
}
// V2.5.5.4, rebuilt from production by restoring its grade lines; V2.5.5.11 changes nothing else.
export function v2554Scoring(scoring) {
  if(scoring.version!==RELEASE_VERSION.model||digest(scoring.levels)!==digest(RELEASE_LEVELS))fail('RELEASE_V2554_BASE_MISMATCH');
  const previous=structuredClone(scoring);previous.version=CANDIDATE_VERSION;previous.levels=structuredClone(V2552_LEVELS);
  return previous;
}
// The deployed V2.5.5.1 equals the V2.5.6 SC-SKY-OFF configuration on the same 655 members; rebuilding it from the
// release configuration (V2.5.5.2 changes reverted) must reproduce that signature before the new release is compared.
export const SKY_OFF_REFERENCE=Object.freeze({source:'V2.5.6 signal run practical_tuning_v7_d3a8721fad7cd295b517, ablation AB-SKY; deployed as V2.5.5.1',
  prediction_signature_sha256:'c7c40b4563efc5a40321356fbf601cf2f59644c7b0213d154afb849c5ecbad38',product_loss:1.034929907064});
// V2.5.5.2 on the same members, first produced by this tool and cross-checked against the golden-window diagnosis
// (ref_docs/Dev_version_record/2026-10-23_黄金窗口离线诊断.md): equal scores except 5 rows at ±1 from the 3-decimal
// golden-window factor; ordinals use the release grade lines.
export const V2552_REFERENCE=Object.freeze({prediction_signature_sha256:'2404453e33e6310088d0bc3242a601ed555ba3994006d6b7997de2662537c5d8',
  product_loss:0.990135853225,score_changed_vs_V2551:388,grade_changed_vs_V2551:186});
// V2.5.5.4 candidate (PRD V2.5.5.4 §3.1): V2.5.5.2 plus the corridor-centre azimuth fix; same grade lines.
// FIX-H (scope HORIZON) limits the fix to the horizon sectors and exists for attribution only.
export const CANDIDATE_VERSION='2.5.5.4';
export function candidateReleaseScoring(scoring,{scope='ALL'}={}) {
  if(scoring.version!==V2552_VERSION||scoring.spatialField?.centerAzimuthOffset!=null)fail('RELEASE_CANDIDATE_BASE_MISMATCH');
  if(!['ALL','HORIZON'].includes(scope))fail('RELEASE_CANDIDATE_SCOPE_UNKNOWN');
  const next=structuredClone(scoring);next.version=CANDIDATE_VERSION;next.spatialField.centerAzimuthOffset=0;
  if(scope==='HORIZON')next.spatialField.centerAzimuthOffsetScope='HORIZON';
  return next;
}
// FIX-ALL on the same 655 members, pinned from the V2.5.5.4 DEV evaluation (practical tuning Policy 10); ordinals use 22/47/66/90.
export const V2554_REFERENCE=Object.freeze({prediction_signature_sha256:'e5102d750ab3c6bac65c5e8baa2f2d914d46742363dbf0960229b2e6bb3b324f',
  product_loss:0.987673889961,score_changed_vs_V2552:323,grade_changed_vs_V2552:28});
// V2.5.5.11 on the same 655 members: the V2.5.5.4 scores graded 19/49/66/90 (PRD V2.5.5.11 §6).
export const V25511_REFERENCE=Object.freeze({prediction_signature_sha256:'160a0e594e177d00701b78f75710a1d06284b04696c2381810be69563319f53b',product_loss:0.858899533658,grade_changed_vs_V2554:91});
// V2.5.5.5 candidate (PRD V2.5.5.5 §3.1): V2.5.5.4 plus the monotone (half-Gaussian) AOD response; same grade lines.
// A 2.5.5.2 base is accepted for the robustness row (A1@2.5.5.2, PRD §4.4).
export const AOD_CANDIDATE_VERSION='2.5.5.5';
export function aodCandidateScoring(scoring) {
  if(![V2552_VERSION,CANDIDATE_VERSION].includes(scoring.version)||scoring.aodResponse!=null)fail('RELEASE_AOD_CANDIDATE_BASE_MISMATCH');
  const next=structuredClone(scoring);next.version=AOD_CANDIDATE_VERSION;next.aodResponse='HALF_GAUSSIAN';
  return next;
}
// A1 = 2.5.5.4 + HALF_GAUSSIAN on the same 655 members, pinned from the V2.5.5.5 DEV evaluation (practical tuning Policy 11).
export const V2555_REFERENCE=Object.freeze({prediction_signature_sha256:'e0a01ba792dc84ded59a30fa9cd39c79abb4d6da8dd924e984844e941f0f1517',
  product_loss:0.999983706283,score_changed_vs_V2554:52,grade_changed_vs_V2554:5});
// V2.5.5.6 candidate (PRD V2.5.5.6 §3): V2.5.5.4 plus the golden-window cloud/rain split; the GW reference is recomputed
// by the V2.5.5.2 rule (mean pre-reference factor of the active DEV rows) and passed in explicitly.
export const GW_SPLIT_VERSION='2.5.5.6';
export function gwSplitScoring(scoring,{cloudSignal='SUN_SIDE_BLOCKING',radarRole='RAIN_GATE',reference}={}) {
  if(scoring.version!==CANDIDATE_VERSION||scoring.evolution?.cloudSignal!=null||scoring.aodResponse!=null)fail('RELEASE_GW_SPLIT_BASE_MISMATCH');
  if(!['SUN_SIDE_BLOCKING','TOTAL_CLOUD'].includes(cloudSignal)||!['RAIN_GATE','IGNORE'].includes(radarRole))fail('RELEASE_GW_SPLIT_OPTION_UNKNOWN');
  const next=structuredClone(scoring);next.version=GW_SPLIT_VERSION;next.evolution.cloudSignal=cloudSignal;next.evolution.radarRole=radarRole;
  if(reference!==undefined){if(!(Number.isFinite(reference)&&reference>0))fail('RELEASE_GW_SPLIT_REFERENCE_INVALID');next.goldenWindow.reference=reference;}
  return next;
}
// W1 on the same 655 members, pinned from the V2.5.5.6 DEV evaluation (practical tuning Policy 12).
export const V2556_REFERENCE=Object.freeze({gw_reference:0.795492,prediction_signature_sha256:'2c277b3be5eabb7e06088a5ba947ad660cdfd12cf57416e95be9f7496fe1f11c',
  product_loss:1.001641308843,score_changed_vs_V2554:343,grade_changed_vs_V2554:49});
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
  const d=differences(source,runtime),allowed={version:['2.4.6',RELEASE_VERSION.model],'illuminationModel.bankShare':[null,.5],'illuminationModel.twilightSaturationMinutes':[null,35],
    'skyState.factorCoefficients.arrivalRiskSlope':[null,.3],'skyState.factorRange':[[0.65,1.15],[1,1]],
    'evolution.openCoverageThreshold':[20,35],'evolution.satelliteOpenThreshold':[25,40],'goldenWindow.reference':[null,.826654],levels:[LEGACY_LEVELS,RELEASE_LEVELS],
    'spatialField.centerAzimuthOffset':[null,0]};
  if(d.length!==10||d.some(v=>!allowed[v.path]||digest([v.source,v.runtime])!==digest(allowed[v.path])))fail('UNEXPECTED_RELEASE_CONFIG_DIFFERENCE');
  for(const [p,v]of Object.entries(RELEASE_VALUES))if(digest(at(runtime,p))!==digest(v))fail('RELEASE_PARAMETER_MISMATCH');
  const reasons={version:'EXPLICIT_MODEL_IDENTITY_CHANGE','skyState.factorRange':'V2551_SKY_EVOLUTION_DISABLED','evolution.openCoverageThreshold':'V2552_GOLDEN_WINDOW_OPEN_THRESHOLD',
    'evolution.satelliteOpenThreshold':'V2552_GOLDEN_WINDOW_OPEN_THRESHOLD','goldenWindow.reference':'V2552_GOLDEN_WINDOW_CENTRED',levels:'V25511_GRADE_LINES','spatialField.centerAzimuthOffset':'V2554_HORIZON_CENTRE_FIX'};
  return d.map(v=>({...v,reason:reasons[v.path]??'ALREADY_PROVED_DEFAULT_EQUIVALENT_FIELD'}));
}
// The deployed V2.5.5.1 configuration: the release scoring with the V2.5.5.2 changes reverted.
export function previousReleaseScoring(scoring) {
  const previous=structuredClone(scoring);
  previous.version='2.5.5.1';previous.evolution.openCoverageThreshold=20;previous.evolution.satelliteOpenThreshold=25;
  delete previous.goldenWindow.reference;previous.levels=structuredClone(LEGACY_LEVELS);
  return previous;
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
// `sources` may point at local copies of the V6 Raw / GT / Model packages when the recorded absolute paths are absent on this
// machine; the loaded bytes must still match the V6 input fingerprints exactly (RELEASE_INPUT_MISMATCH otherwise).
export async function prepareRelease(output,{progress=()=>{},sources=null}={}) {
  output=await safeOutput(output);const source=path.join(APP_ROOT,'dataset/practical_tuning',SOURCE_RUN),code=await codeIdentity();
  const inspected=await inspectPractical(source),selectedBytes=await readFile(path.join(source,'selected_effective_config.json'));
  if(hash(selectedBytes)!==SOURCE_CONFIG_SHA||inspected.result.selected_candidate!=='practical_candidate_v6_34df8f13f05d6275e49d')fail('RELEASE_SOURCE_IDENTITY_MISMATCH');
  const selected=JSON.parse(selectedBytes),request=await json(path.join(source,'verification_request.json')),production=await loadProduction();
  if(production.version.model!==RELEASE_VERSION.model||production.version.app!==RELEASE_VERSION.app||production.version.assetRevision!==RELEASE_VERSION.assetRevision||production.scoring.version!==RELEASE_VERSION.model)fail('RELEASE_VERSION_MISMATCH');
  const configDiff=compareSelected(selected,production.scoring),effective=await captureEffective(production.SS),loaded=await loadPool(sources??inspected.spec.sources,progress);
  if(digest(loaded.fingerprints)!==digest(inspected.spec.identity.inputs)||loaded.exclusions.length)fail('RELEASE_INPUT_MISMATCH');
  const byId=new Map(loaded.rows.map(r=>[r.snapshot_id,r])),rows=weightedRows(request.pool.included.map(r=>{const live=byId.get(r.snapshot_id);if(!live||['event_id','gt_ordinal','gt_confidence','input_sha256'].some(k=>r[k]!==live[k]))fail('RELEASE_MEMBER_MISMATCH');return live;}));
  if(rows.length!==655||byId.size!==655||rows.some((r,i)=>r.event_normalized_weight!==request.pool.included[i].event_normalized_weight))fail('RELEASE_POOL_MISMATCH');
  const thresholds=gradeThresholdsFromLevels(production.scoring.levels);
  if(digest(thresholds)!==digest(gradeThresholdsForModelVersion(RELEASE_VERSION.model)))fail('RELEASE_GRADE_LINES_NOT_REGISTERED');
  const v2552Thresholds=gradeThresholdsFromLevels(V2552_LEVELS);
  const v2552Config=v2552Scoring(production.scoring),v2552Model=buildModelConfig(v2552Config),previousModel=buildModelConfig(previousReleaseScoring(v2552Config));
  const scores=[],v2552Scores=[],previousScores=[],records=[];
  for(const [i,row]of rows.entries()){
    // previous_* is the deployed V2.5.5.1 (20/40/60/90); v2552_* is the rebuilt V2.5.5.2 and v2554_* grades the release score with
    // the V2.5.5.4 lines (both 22/47/66/90); release_* is V2.5.5.11 (19/49/66/90). V2.5.5.11 and V2.5.5.4 share the same scores.
    const result=await runReplay(row.replay,{modelConfig:production.model,versionedGradeLines:true}),score=result.actual.score;
    const v2552=(await runReplay(row.replay,{modelConfig:v2552Model,versionedGradeLines:true})).actual.score;
    const previous=(await runReplay(row.replay,{modelConfig:previousModel})).actual.score;
    if(result.actual.sky_evolution_factor!==1)fail('RELEASE_SKY_FACTOR_NOT_DISABLED');
    scores.push(score);v2552Scores.push(v2552);previousScores.push(previous);
    records.push({snapshot_id:row.snapshot_id,event_id:row.event_id,gt_ordinal:row.gt_ordinal,event_weight:row.event_normalized_weight,previous_score:previous,v2552_score:v2552,release_score:score,
      previous_ordinal:scoreToOrdinal(previous),v2552_ordinal:gradeScore(v2552,v2552Thresholds),v2554_ordinal:gradeScore(score,v2552Thresholds),release_ordinal:gradeScore(score,thresholds),release_gw_factor:result.actual.gw_factor});
    if((i+1)%100===0||i+1===rows.length)progress(`发布一致性 ${i+1}/${rows.length}：V2.5.5.1 / V2.5.5.2 / V2.5.5.4 复现与 V2.5.5.11 判级`);
  }
  const previousSignature=digest(rows.map((r,i)=>[r.snapshot_id,previousScores[i],scoreToOrdinal(previousScores[i])]));
  if(previousSignature!==SKY_OFF_REFERENCE.prediction_signature_sha256)fail('RELEASE_PREVIOUS_DIFFERS_FROM_V2551');
  const previousMetrics=highCloudMetrics(rows,previousScores);if(Math.abs(previousMetrics.product_loss-SKY_OFF_REFERENCE.product_loss)>1e-9)fail('RELEASE_PREVIOUS_METRICS_DIFFERS');
  const v2552Metrics=highCloudMetrics(rows,v2552Scores,v2552Thresholds);
  const v2552Reference={prediction_signature_sha256:digest(rows.map((r,i)=>[r.snapshot_id,v2552Scores[i],gradeScore(v2552Scores[i],v2552Thresholds)])),product_loss:v2552Metrics.product_loss,
    score_changed_vs_V2551:records.filter(r=>r.previous_score!==r.v2552_score).length,grade_changed_vs_V2551:records.filter(r=>r.previous_ordinal!==r.v2552_ordinal).length};
  if(digest(v2552Reference)!==digest(V2552_REFERENCE))fail('RELEASE_REBUILT_V2552_DIFFERS_FROM_REFERENCE');
  const v2554Signature=digest(rows.map((r,i)=>[r.snapshot_id,scores[i],gradeScore(scores[i],v2552Thresholds)]));
  const changed=records.filter(r=>r.v2552_score!==r.release_score).length,gradeChanged=records.filter(r=>r.v2552_ordinal!==r.v2554_ordinal).length;
  const v2554Metrics=highCloudMetrics(rows,scores,v2552Thresholds);
  const v2554Reference={prediction_signature_sha256:v2554Signature,product_loss:v2554Metrics.product_loss,score_changed_vs_V2552:changed,grade_changed_vs_V2552:gradeChanged};
  if(digest(v2554Reference)!==digest(V2554_REFERENCE))fail('RELEASE_PREDICTION_DIFFERS_FROM_V2554_REFERENCE');
  const signature=digest(rows.map((r,i)=>[r.snapshot_id,scores[i],gradeScore(scores[i],thresholds)]));
  const metrics=highCloudMetrics(rows,scores,thresholds);
  const reference={prediction_signature_sha256:signature,product_loss:metrics.product_loss,grade_changed_vs_V2554:records.filter(r=>r.v2554_ordinal!==r.release_ordinal).length};
  if(digest(reference)!==digest(V25511_REFERENCE))fail('RELEASE_PREDICTION_DIFFERS_FROM_V25511_REFERENCE');
  await checkInputs(loaded);if((await codeIdentity()).sha256!==code.sha256)fail('CODE_CHANGED_DURING_RELEASE');
  await mkdir(output,{recursive:true});const put=async(n,v)=>writeFile(path.join(output,n),canonicalJson(v)+'\n');
  const legacy=await json(path.join(source,'original_control_config.json'));
  const diff={parameter_changes:Object.entries(RELEASE_VALUES).map(([p,v])=>({path:p,experiment_B0:at(legacy,p),V2550:at(selected,p),release:v})),candidate_runtime_differences:configDiff,
    unchanged:{highCloudCenter:60,highCloudWidth:25,minimumWeatherWeight:.05,illuminationModel:{bankShare:.5,twilightSaturationMinutes:35},arrivalRiskSlope:.3,goldenWindowWindow:{beforeSunsetMinutes:180,afterSunsetMinutes:30}},new_default_is_not_old_default:true};
  const comparison={status:'PASS',scope:'RELEASE_CONSISTENCY_ON_REUSED_DEVELOPMENT_DATA; NOT_INDEPENDENT_TEST',snapshot_count:655,event_count:metrics.event_count,date_count:metrics.date_count,
    V2551_metrics:previousMetrics,V2552_metrics:v2552Metrics,V2554_metrics:v2554Metrics,release_metrics:metrics,release_grade_thresholds:thresholds,V2551_grade_thresholds:LEGACY_GRADE_THRESHOLDS,
    V2551_reproduced:SKY_OFF_REFERENCE,V2552_reproduced:V2552_REFERENCE,V2554_reproduced:V2554_REFERENCE,V25511_reference:V25511_REFERENCE,score_changed_vs_V2552:changed,grade_changed_vs_V2552:gradeChanged,full_search_repeated:false,
    source_config_file_sha256:SOURCE_CONFIG_SHA,runtime_scoring_config_sha256:hash(canonicalJson(production.scoring)),replay_effective_config_sha256:effective.config_hash,
    prediction_signature_sha256:signature,V2554_prediction_signature_sha256:v2554Signature,V2552_prediction_signature_sha256:v2552Reference.prediction_signature_sha256,V2551_prediction_signature_sha256:previousSignature,V2550_prediction_signature_sha256:request.selected.predictions_sha256};
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
  try{
    if(process.argv[2]!=='prepare'||!process.argv[3])fail('USAGE_PREPARE_OUTPUT');
    const args=process.argv.slice(4),flags={};
    for(let i=0;i<args.length;i+=2){if(!['--raw','--gt','--model'].includes(args[i])||!args[i+1]||flags[args[i]])fail('INVALID_ARGUMENTS');flags[args[i]]=path.resolve(args[i+1]);}
    const given=Object.keys(flags).length;if(given&&given!==3)fail('INVALID_ARGUMENTS');
    const sources=given?{raw:flags['--raw'],gt:flags['--gt'],model:flags['--model']}:null;
    console.log(canonicalJson(await prepareRelease(process.argv[3],{progress:console.error,sources})));
  }
  catch(e){console.error(e.code??e.message);process.exitCode=1;}
}
