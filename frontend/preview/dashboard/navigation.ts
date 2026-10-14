const router={push:(_url:string)=>{window.parent.postMessage({type:'notice',text:'当前为 Dashboard 视觉验收页，导航未连接正式服务。'},location.origin);},replace:(_url:string)=>{},refresh:()=>{}};
export const useRouter=()=>router;
export const usePathname=()=>'/dashboard';
export const useSearchParams=()=>new URLSearchParams();
