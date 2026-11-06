type BluetoothChooser = {
  requestDevice(options: { filters: { name: string }[] }): Promise<{ name?: string }>;
};

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

export async function chooseBeacon(names: string[]) {
  const adapter = bluetooth();
  if (!window.isSecureContext || !adapter || names.length === 0)
    throw new Error('이 브라우저에서는 매장 비콘을 선택할 수 없어요.');
  const device = await adapter.requestDevice({
    filters: [...new Set(names)].map(name => ({ name })),
  });
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
