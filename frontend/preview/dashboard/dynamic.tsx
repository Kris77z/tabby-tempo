import {lazy,Suspense,type ComponentType} from 'react';
export default function dynamic<P extends object>(load:()=>Promise<{default:ComponentType<P>}>){const C=lazy(load);return function PreviewDynamic(props:P){return <Suspense fallback={null}><C {...props}/></Suspense>;};}
