const CHECK_INTERVAL_MS = 2500;
const AUTOMATIC_CHECKS = 3;
const WAKE_COOLDOWN_MS = 8000;

type Browser = Pick<Window, 'addEventListener' | 'removeEventListener' | 'navigator'>;
type Page = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;

/** One foreground checkout can use at most three automatic reads per wake. */
export function watchPaymentReturn(
  check: (manual: boolean) => Promise<boolean>,
  checkOnStart: boolean,
  browser: Browser = window,
  page: Page = document,
) {
  let active = true;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = 0;
  let lastCheck = -Infinity;
  let lastWake = -Infinity;
  let resumedDuringRead = false;

  const available = () => active && page.visibilityState === 'visible' && browser.navigator.onLine !== false;

  function pause() {
    clearTimeout(timer);
    timer = undefined;
    remaining = 0;
    resumedDuringRead = false;
  }

  function queue(manual = false) {
    timer = setTimeout(async () => {
      timer = undefined;
      if (!available() || !remaining) return;
      lastCheck = Date.now();
      remaining--;
      inFlight = true;
      try {
        if (await check(manual)) {
          active = false;
          pause();
        }
      } catch {
        // A failed read is eligible for the next check in this round.
      } finally {
        inFlight = false;
        if (available() && remaining) queue();
        else if (resumedDuringRead) {
          resumedDuringRead = false;
          wake('return');
        }
      }
    }, Math.max(0, CHECK_INTERVAL_MS - (Date.now() - lastCheck)));
  }

  function wake(source: 'event' | 'return' | 'manual') {
    if (!available() || timer !== undefined) return;
    if (inFlight) {
      if (source === 'return' && remaining === 0) resumedDuringRead = true;
      return;
    }
    if (source === 'event' && Date.now() - lastWake < WAKE_COOLDOWN_MS) return;
    lastWake = Date.now();
    remaining = source === 'manual' ? 1 : AUTOMATIC_CHECKS;
    queue(source === 'manual');
  }

  const onFocus = () => wake('event');
  const onPageShow = (event: Event) => {
    // The hook rehydrates persisted pages before it starts a new watcher.
    if (!(event as PageTransitionEvent).persisted) wake('event');
  };
  const onVisible = () => {
    if (page.visibilityState === 'visible') wake('return');
    else pause();
  };
  const onOnline = () => wake('return');
  browser.addEventListener('pageshow', onPageShow);
  browser.addEventListener('pagehide', pause);
  browser.addEventListener('focus', onFocus);
  browser.addEventListener('online', onOnline);
  browser.addEventListener('offline', pause);
  page.addEventListener('visibilitychange', onVisible);
  if (checkOnStart) wake('return');

  return {
    checkNow: () => wake('manual'),
    close() {
      active = false;
      pause();
      browser.removeEventListener('pageshow', onPageShow);
      browser.removeEventListener('pagehide', pause);
      browser.removeEventListener('focus', onFocus);
      browser.removeEventListener('online', onOnline);
      browser.removeEventListener('offline', pause);
      page.removeEventListener('visibilitychange', onVisible);
    },
  };
}
