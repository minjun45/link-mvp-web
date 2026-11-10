type BluetoothChooser = {
  requestDevice(options: { filters: { name: string }[] } | { acceptAllDevices: true }): Promise<{ name?: string }>;
};
type BluetoothRequest = Parameters<BluetoothChooser['requestDevice']>[0];
type RequestStatus = {
  phase: 'requesting' | 'selected' | 'failed';
  userActivation?: boolean;
  error?: string;
};
let lastRequest: RequestStatus | undefined;

type SpeechRecognition = {
  lang: string;
  start(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechBrowser = Window & {
  SpeechRecognition?: new () => SpeechRecognition;
  webkitSpeechRecognition?: new () => SpeechRecognition;
};

function bluetooth() {
  return (navigator as Navigator & { bluetooth?: BluetoothChooser }).bluetooth;
}

export function canChooseBeacon() {
  return window.isSecureContext && typeof bluetooth()?.requestDevice === 'function';
}

export function getBluetoothStatus() {
  const agent = navigator.userAgent || '';
  const samsung = agent.match(/SamsungBrowser\/([\d.]+)/);
  const chrome = agent.match(/Chrome\/([\d.]+)/);
  return {
    browser: samsung ? `삼성 인터넷 ${samsung[1]}` : chrome ? `Chrome ${chrome[1]}` : '현재 브라우저',
    secure: window.isSecureContext,
    api: typeof bluetooth()?.requestDevice === 'function',
    request: lastRequest ? { ...lastRequest } : undefined,
  };
}

function requireBluetooth() {
  if (!window.isSecureContext)
    throw new Error('Bluetooth 검색은 HTTPS 연결이 필요해요. 개발 중에는 검색하는 기기 자신의 localhost 주소도 사용할 수 있어요.');
  const adapter = bluetooth();
  if (typeof adapter?.requestDevice !== 'function')
    throw new Error('현재 브라우저에 Web Bluetooth 기능이 없어요. 삼성 인터넷을 최신 버전으로 업데이트하고, 계속 안 되면 Android Chrome에서 확인해 주세요.');
  return adapter;
}

export function bluetoothErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'SecurityError')
      return 'Bluetooth 요청이 브라우저에서 차단됐어요. 버튼을 직접 눌러 다시 시도하고 사이트의 Bluetooth 접근 설정을 확인해 주세요. [SecurityError]';
    if (error.name === 'NotAllowedError')
      return 'Bluetooth 접근이 허용되지 않았어요. 휴대폰 설정에서 이 브라우저의 주변 기기 권한과 사이트 권한을 확인해 주세요. [NotAllowedError]';
    if (error.name === 'NotFoundError')
      return '기기를 선택하지 않았거나 조건에 맞는 기기를 찾지 못했어요. 비콘 광고를 켜고 다시 선택해 주세요. [NotFoundError]';
  }
  return error instanceof Error ? error.message : 'Bluetooth 요청을 완료하지 못했어요.';
}

async function requestBluetooth(options: BluetoothRequest) {
  const status: RequestStatus = { phase: 'requesting', userActivation: navigator.userActivation?.isActive };
  lastRequest = status;
  try {
    // No await, permission query, state transition or timer before this call.
    const pending = requireBluetooth().requestDevice(options);
    const device = await pending;
    status.phase = 'selected';
    return device;
  } catch (error) {
    status.phase = 'failed';
    status.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(bluetoothErrorMessage(error));
  }
}

export async function chooseBeacon(names: string[]) {
  if (names.length === 0)
    throw new Error('등록된 매장이 없어요. 이름으로 검색하거나 데모로 체험해 주세요.');
  const device = await requestBluetooth({
    filters: [...new Set(names)].map(name => ({ name })),
  });
  return device.name;
}

// Diagnostics only: show the browser's BLE candidates without store-name
// filtering. Read only the chosen device's name; do not connect or map it to a store.
export async function inspectBeacon() {
  const device = await requestBluetooth({ acceptAllDevices: true });
  return device.name;
}

const signals: Record<string, { frequency: number; vibration: number[] }> = {
  found: { frequency: 640, vibration: [80, 40, 80] },
  selected: { frequency: 520, vibration: [40] },
  success: { frequency: 780, vibration: [90, 55, 120] },
  error: { frequency: 260, vibration: [180] },
};
let audio: AudioContext | undefined;

export function signal(kind: string) {
  const cue = signals[kind];
  if (!cue) return;
  navigator.vibrate?.(cue.vibration);
  if (!window.AudioContext) return;
  // Browsers only unlock audio after a user gesture.
  if (!audio && navigator.userActivation?.isActive) audio = new AudioContext();
  if (!audio) return;
  const context = audio;
  function play() {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = cue.frequency;
    gain.gain.setValueAtTime(0.075, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.13);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.14);
  }
  if (context.state === 'running') play();
  else if (navigator.userActivation?.isActive) void context.resume().then(play).catch(() => {});
}

export function speak(text: string) {
  if (!window.speechSynthesis) return;
  const speech = new SpeechSynthesisUtterance(text);
  speech.lang = 'ko-KR';
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(speech);
}

export async function recognize(): Promise<string> {
  const browser = window as SpeechBrowser;
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  if (!Recognition)
    throw new Error('이 브라우저는 음성 검색을 지원하지 않아요. 검색어를 입력해 주세요.');
  return new Promise((resolve, reject) => {
    const recognition = new Recognition();
    recognition.lang = 'ko-KR';
    recognition.onresult = event => resolve(event.results[0]?.[0]?.transcript || '');
    recognition.onend = () => resolve('');
    recognition.onerror = event => {
      if (event.error === 'no-speech' || event.error === 'aborted') resolve('');
      else reject(new Error('음성 검색을 할 수 없어요. 마이크 권한을 확인하거나 검색어를 입력해 주세요.'));
    };
    recognition.start();
  });
}

export function openPayment(url: string, base: string) {
  const target = new URL(url);
  const kakao = /(^|\.)(kakao\.com|kakaopay\.com)$/.test(target.hostname);
  if (
    target.username ||
    target.password ||
    (target.origin !== new URL(base).origin && !(target.protocol === 'https:' && kakao))
  ) throw new Error('결제 창 주소를 확인할 수 없어요.');
  window.open(target.href, '_blank', 'noopener,noreferrer');
}
