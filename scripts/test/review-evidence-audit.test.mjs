import assert from 'node:assert/strict';
import test from 'node:test';
import {buildReviewEvidence,validateReviewEvidenceManifest} from '../review-evidence.mjs';
test('replay cannot self-attest a changed financial claim or omit a failed/unknown scenario',()=>{
 for(const mutate of [m=>{m.claims[0].checkedFacts={netProfit:'99999'}},m=>{m.sources.splice(0,1)},m=>{m.timeline=[]}]){const m=buildReviewEvidence();mutate(m);assert.throws(()=>validateReviewEvidenceManifest(m));}
});
