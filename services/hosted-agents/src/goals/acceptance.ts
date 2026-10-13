/** Deterministic checks supplement model review; they do not establish factual
 * truth. Counts deliberately include punctuation in Chinese character limits. */
export function inspectGoalArtifact(goal:string,artifact:string,observedAt?:string){
 const characters=Array.from(artifact.replace(/\s/g,"")).length;
 const words=(artifact.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)??[]).length;
 const checks:string[]=[];
 const maximums:number[]=[];
 for(const match of goal.matchAll(/(?:不超过|最多|至多|限于?|控制在|少于)\s*(\d{1,6})\s*字|(\d{1,6})\s*字\s*(?:以内|以下|内)/g)){const n=Number(match[1]??match[2]);if(n>0)maximums.push(n);}
 const maxCharacters=maximums.length?Math.min(...maximums):undefined;
 if(maxCharacters!==undefined&&characters>maxCharacters)checks.push(`Explicit character limit exceeded: ${characters} non-whitespace Unicode characters, maximum ${maxCharacters} (punctuation included).`);
 const english=goal.match(/(?:at most|no more than|under|within|maximum(?: of)?)\s+(\d{1,6})\s+words/i);
 const maxWords=english?Number(english[1]):undefined;
 if(maxWords!==undefined&&words>maxWords)checks.push(`Explicit word limit exceeded: ${words} words, maximum ${maxWords}.`);
 if(/(?:不|勿|禁止|不得|不要).{0,8}(?:编造|杜撰|虚构)|do not (?:invent|fabricate)/i.test(goal)){
  const compactGoal=goal.replace(/\s/g,""),compactOutput=artifact.replace(/\s/g,"");
  const dates=Array.from(compactOutput.matchAll(/(?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{4}[-/]\d{1,2}[-/]\d{1,2}/g),m=>m[0]);
  for(const date of new Set(dates))if(!compactGoal.includes(date)&&date!==observedAt?.slice(0,10))checks.push(`Unsupported concrete date: ${date}; the original goal forbids invented information and supplies no such date.`);
 }
 return{characters,words,maxCharacters,maxWords,failures:checks};
}
