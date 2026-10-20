import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {buildReviewEvidence,EVIDENCE_REGISTRY,validateReviewEvidenceManifest} from '../review-evidence.mjs';
const load=file=>JSON.parse(readFileSync(new URL(`../../${file}`,import.meta.url),'utf8'));
test('closed Tempo-owned registry is nonempty and excludes upstream historical/public-chain assertions',()=>{
 const a=buildReviewEvidence();assert.deepEqual(a,buildReviewEvidence());assert.equal(a.sources.length,7);assert.ok(a.claims.length>=7);
 for(const s of a.sources){assert.ok(s.file.startsWith('docs/acceptance/tempo-local-20261020/'));assert.notEqual(s.environment.kind,'public-monad');assert.equal(s.sha256,createHash('sha256').update(readFileSync(new URL(`../../${s.file}`,import.meta.url))).digest('hex'))}
 assert.equal(validateReviewEvidenceManifest(a),true);
 assert.throws(()=>buildReviewEvidence({overrides:{'../../private.json':{}}}));
});
test('saved arithmetic and provenance mutations are rejected even with recomputed source checksums',()=>{
 const file=EVIDENCE_REGISTRY.find(x=>x.kind==='local-economic').file;
 for(const mutate of [d=>{d.accounting.totals.netOperatingRaw='999999'},d=>{d.scenarios[1].payment.values.fromCash='40001'},d=>{d.provenance.chainId='42431'},d=>{d.cleanup.ownedProcessesStopped=false}]){
 const d=load(file);mutate(d);assert.throws(()=>buildReviewEvidence({overrides:{[file]:d}}));}
});
