import { createRoot } from 'react-dom/client';
import App from './App';
import './web.css';
import { kakaoPageOrigin } from './src/services/api';

const root = createRoot(document.getElementById('root')!);
async function start() {
  if (document.querySelector('meta[name="link-kakaopay-qa"]')) {
    try {
      if (!kakaoPageOrigin()) throw new Error();
      const response = await fetch('/api/config', {
        headers: { 'X-Link-Kakao-Test': '1' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (response.status === 401) {
        location.replace('/qa-access');
        return;
      }
      if (!response.ok || (await response.json()).kakaopayTest !== true) throw new Error();
    } catch {
      root.render(<main>
        <h1>LINK QA에 연결할 수 없어요</h1>
        <p>QA 주소와 서버 상태를 확인해 주세요.</p>
        <button type="button" onClick={() => location.reload()}>다시 시도</button>
      </main>);
      return;
    }
  }
  root.render(<App />);
}
void start();
