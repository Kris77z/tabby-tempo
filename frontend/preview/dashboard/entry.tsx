import {createRoot} from 'react-dom/client';
import HostedApp from '../../components/hosted/hosted-app';
import {PreviewProvider} from './state';
import terminal from '../../components/terminal/terminal.module.css';
import '../../app/globals.css';
import './preview.css';
// Keep the isolated visual preview offline, including the embedded game lobby.
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (url.pathname === '/api/arena/play' && !url.search && method === 'GET') {
    return Response.json({matches: [], history: [], bot: {name: 'Tabby', description: ''}, storage: 'preview'});
  }
  return Response.json({message: '此页用于样式验收；实际对局请在 Dashboard 中运行。'}, {status: 503});
};
createRoot(document.getElementById('root')!).render(<div className={terminal.theme}><PreviewProvider><HostedApp/></PreviewProvider></div>);
