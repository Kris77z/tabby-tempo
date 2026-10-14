import type {AnchorHTMLAttributes} from 'react';
export default function Link(props:AnchorHTMLAttributes<HTMLAnchorElement>){return <a {...props} onClick={e=>{e.preventDefault();window.parent.postMessage({type:'notice',text:'当前为 Dashboard 视觉验收页，导航未连接正式服务。'},location.origin);}}/>;}
