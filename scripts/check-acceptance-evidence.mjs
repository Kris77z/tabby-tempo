import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {buildReviewEvidence,validateReviewEvidenceManifest} from './review-evidence.mjs';
export function checkEvidence(options={}){const manifest=buildReviewEvidence(options);validateReviewEvidenceManifest(manifest);return manifest;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const m=checkEvidence();console.log(JSON.stringify({status:'passed',registeredLocalReports:m.sources.length,claims:m.claims.length,publicNetworkUsed:false}));}
