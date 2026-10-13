import type { ReactNode } from 'react';
import styles from './workspace.module.css';
// Small, deliberately text-only Markdown renderer. Model HTML and URLs never execute.
function inline(text:string):ReactNode[]{return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part,i)=>part.startsWith('**')&&part.endsWith('**')?<strong key={i}>{part.slice(2,-2)}</strong>:part.startsWith('`')&&part.endsWith('`')?<code key={i}>{part.slice(1,-1)}</code>:part);}
const cells=(line:string)=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(x=>x.trim());
export function MissionMarkdown({text}:{text:string}){
 const lines=text.split('\n'),blocks:ReactNode[]=[];
 for(let i=0;i<lines.length;){const line=lines[i];
  if(!line.trim()){i++;continue;}
  if(line.startsWith('```')){const code:string[]=[];i++;while(i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i++]);i++;blocks.push(<pre key={i}><code>{code.join('\n')}</code></pre>);continue;}
  if(line.includes('|')&&i+1<lines.length&&cells(lines[i+1]).every(c=>/^:?-{3,}:?$/.test(c))){const headers=cells(line),rows:string[][]=[];i+=2;while(i<lines.length&&lines[i].includes('|'))rows.push(cells(lines[i++]));blocks.push(<div className={styles.tableScroll} key={i}><table><thead><tr>{headers.map((h,j)=><th key={j}>{inline(h)}</th>)}</tr></thead><tbody>{rows.map((row,j)=><tr key={j}>{row.map((c,k)=><td key={k}>{inline(c)}</td>)}</tr>)}</tbody></table></div>);continue;}
  if(/^#{1,6}\s/.test(line)){blocks.push(<h3 key={i}>{inline(line.replace(/^#{1,6}\s+/,''))}</h3>);i++;continue;}
  if(/^\s*([-*_])\1\1+\s*$/.test(line)){blocks.push(<hr key={i}/>);i++;continue;}
  blocks.push(<p key={i}>{inline(line)}</p>);i++;
 }
 return <div className={styles.markdown}>{blocks}</div>;
}
