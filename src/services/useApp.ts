import { useEffect, useReducer, useRef, useState } from 'react';
import { catalogConnection, initial, reduce, snapshot, type Action } from '../core/flow';
import { KAKAO_TEST_PROVIDER, type Snapshot, type State } from '../core/types';
import { paymentMatchesRequest } from '../core/domain';
import { isOrder, isPayment } from '../core/savedData';
import * as Device from '../native/browserDevice';
import { persist, readSnapshot, SnapshotConflict } from './storage';
import * as api from './api';
import { startDiscovery } from './discovery';
import { advancePayment, canOpenKakaoPayment, openKakaoCheckout, paymentResult, returnKakaoPaymentToCart } from './checkout';
import { watchPaymentReturn } from './paymentReturn';

export function useApp() {
  const [s, dispatch] = useReducer(reduce, initial);
  const live = useRef(s);
  live.current = s;
  const [busy, setBusy] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [kakaoCheckStatus, setKakaoCheckStatus] = useState<'idle' | 'checking' | 'checked' | 'unavailable'>('idle');
  const openingKakao = useRef(false);
  const returningKakao = useRef(false);
  const kakaoDecision = useRef(0);
  const paymentWatcher = useRef<ReturnType<typeof watchPaymentReturn> | null>(null);
  const page = useRef({ epoch: 0, suspended: false, resumeRevision: undefined as number | undefined });
  const presented = useRef<Snapshot | undefined>(undefined);
  const reloadStored = useRef<((conflict?: boolean) => void) | undefined>(undefined);
  const handleConflict = (error: unknown) => {
    if (!(error instanceof SnapshotConflict)) return false;
    reloadStored.current?.(true);
    return true;
  };
  function pageGuard() {
    const epoch = page.current.epoch;
    return () => !page.current.suspended && page.current.epoch === epoch;
  }
  const [listening, setListening] = useState(false);
  const voiceRequest = useRef<AbortController | null>(null);
  function cancelVoiceSearch() {
    const request = voiceRequest.current;
    if (!request) return;
    voiceRequest.current = null;
    setListening(false);
    request.abort();
  }
  useEffect(() => cancelVoiceSearch, [s.flow, s.revision]);

  const completing = useRef(false);
  const pickingUp = useRef(false);
  const discovery = useRef<{ revision: number; stop: () => void } | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const kakaoOrigin = api.kakaoPageOrigin();
    const kakaoPage = !!kakaoOrigin;
    async function hydrate(resumed = false, conflict = false) {
      const epoch = page.current.epoch;
      const saved = await readSnapshot().catch(() => null);
      if (!active || page.current.epoch !== epoch) return;
      presented.current = undefined;
      setKakaoCheckStatus('idle');
      if (resumed) page.current.resumeRevision = live.current.revision + 1;
      dispatch({
        type: 'HYDRATE', snapshot: saved, kakaoTest: kakaoPage, kakaoOrigin, resumed,
        stores: api.stores, products: api.products,
      });
      if (conflict && saved !== null) dispatch({ type: 'STORAGE_ERROR', message: '다른 탭에서 변경된 최신 주문을 불러왔어요.' });
    }
    const onPageHide = () => {
      page.current.epoch++;
      page.current.suspended = true;
    };
    const resync = (conflict = false) => {
      // Re-read while the old render and its queued writes are still suspended.
      onPageHide();
      void hydrate(true, conflict);
    };
    reloadStored.current = resync;
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resync();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    void hydrate();
    return () => {
      active = false;
      reloadStored.current = undefined;
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      discovery.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);
  useEffect(() => {
    if (page.current.resumeRevision !== s.revision) return;
    page.current.resumeRevision = undefined;
    page.current.suspended = false;
    openingKakao.current = false;
  }, [s.revision]);
  useEffect(() => {
    if (s.flow === 'BOOT') return;
    const before = presented.current;
    const current = snapshot(s);
    presented.current = current;
    const canWrite = pageGuard();
    if (before && canWrite() && s.flow !== 'V5-13' && !s.recoveryRequired)
      persist(current, canWrite, before).catch(error => {
        if (canWrite() && !handleConflict(error)) dispatch({
          type: 'STORAGE_ERROR',
          message: '기기에 주문 내용을 저장하지 못했어요. 새로고침 전에 저장 공간을 확인해 주세요.',
        });
      });
  }, [
    s.recoveryRequired,
    s.onboarded,
    s.settings,
    s.storeId,
    s.cart,
    s.history,
    s.request,
    s.payment,
    s.order,
    s.queuedOrders,
  ]);
  useEffect(() => {
    if (s.signal) Device.signal(s.signal);
  }, [s.signal, s.revision]);
  useEffect(() => {
    let cancelled = false;
    const state = s;
    const currentPage = pageGuard();
    const isCurrent = () => currentPage() && !cancelled && live.current.revision === state.revision;
    const kakao = (state.payment?.connection ?? state.request?.connection)?.mode === KAKAO_TEST_PROVIDER;
    const checkPayment = !state.recoveryRequired && (
      state.flow === 'V5-09' || (state.flow === 'P02-V' && !kakao && (!!state.payment || state.retryVerification))
    );
    setCheckingPayment(checkPayment);
    const send = (action: Parameters<typeof dispatch>[0]) => {
      if (isCurrent()) dispatch(action);
    };
    async function run() {
      if (state.flow === 'START' && !state.order && !state.request && !state.payment && !state.recoveryRequired) {
        try {
          send({ type: 'STORES', stores: await api.getStores(catalogConnection(state)) });
        } catch (e) {
          send({ type: 'FAIL', flow: 'START', message: message(e) });
        }
      } else if (state.flow === 'V5-04') {
        try {
          send({
            type: 'MENU_LOADED',
            products: await api.getMenu(catalogConnection(state), state.storeId!),
          });
        } catch (e) {
          send({
            type: 'FAIL',
            flow: e instanceof api.ApiError && e.code === 409 ? 'E05' : 'E04',
            message: message(e),
          });
        }
      } else if (checkPayment) {
        try {
          const result = await advancePayment(state, isCurrent);
          if (result) send(result);
        } catch (error) {
          if (isCurrent() && !handleConflict(error)) send({ type: 'FAIL', flow: 'P02-V', message: message(error) });
        } finally {
          if (isCurrent()) setCheckingPayment(false);
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
    // revision marks explicit transitions/retries, not text input or persistence updates.
  }, [s.flow, s.revision]);
  const watchKakao = !s.recoveryRequired && ['PAYMENT_EXTERNAL', 'P02-V'].includes(s.flow) &&
    (s.payment?.connection ?? s.request?.connection)?.mode === KAKAO_TEST_PROVIDER;
  const watchedPaymentId = watchKakao ? s.payment?.id : undefined;
  const watchedRequestKey = watchKakao && !watchedPaymentId ? s.request?.key : undefined;
  useEffect(() => {
    const autoCheck = s.flow === 'P02-V' && !!watchedPaymentId;
    setKakaoCheckStatus(autoCheck ? navigator.onLine === false ? 'unavailable' : 'checking' : 'idle');
    if (!watchedPaymentId && !watchedRequestKey) return;
    const currentPage = pageGuard();
    const revision = s.revision;
    let active = true;
    const requestKey = s.request?.key;
    const isCurrent = () => active && currentPage() && live.current.revision === revision &&
      live.current.payment?.id === watchedPaymentId && live.current.request?.key === requestKey;
    const interrupted = () => {
      if (isCurrent() && !returningKakao.current) setKakaoCheckStatus('unavailable');
    };
    const watcher = watchPaymentReturn(async read => {
      if (!isCurrent()) return true;
      const decision = kakaoDecision.current;
      const canApply = () => isCurrent() && decision === kakaoDecision.current && !returningKakao.current;
      if (!canApply()) return false;
      const state = live.current;
      if (read.manual) setKakaoCheckStatus('checking');
      let checked = false;
      try {
        // Lost preparation responses are replayed with the stored key only by an explicit check.
        const result = await advancePayment(watchedPaymentId ? state : { ...state, retryVerification: true }, canApply);
        if (!canApply()) return !isCurrent();
        if (!result) return true;
        checked = result.type === 'PAYMENT_RESULT' && !result.error;
        dispatch(result.type === 'PAYMENT_RESULT' || result.type === 'FAIL' ? { ...result, revision } : result);
        return result.type === 'PAYMENT_RESULT' &&
          (!!result.order || ['cancelled', 'failed', 'expired'].includes(result.payment.state));
      } catch (error) {
        if (canApply() && handleConflict(error)) return true;
        throw error;
      } finally {
        if (canApply()) setKakaoCheckStatus(checked ? 'checked' : 'unavailable');
      }
    }, autoCheck, window, document, {
      automatic: !!watchedPaymentId,
      onManualInterrupted: interrupted,
    });
    window.addEventListener('offline', interrupted);
    paymentWatcher.current = watcher;
    return () => {
      active = false;
      watcher.close();
      window.removeEventListener('offline', interrupted);
      paymentWatcher.current = null;
    };
  }, [watchedPaymentId, watchedRequestKey, s.flow, s.revision]);
  useEffect(() => {
    const active = discovery.current;
    if (active && (s.flow !== 'V5-01' || s.revision !== active.revision)) {
      active.stop();
      discovery.current = undefined;
    }
  }, [s.flow, s.revision]);
  useEffect(() => {
    if (!s.order || s.recoveryRequired || !['V5-10', 'V5-11', 'V5-12'].includes(s.flow) ||
        (s.orderStatusChecked && s.order.status === 'ready')) return;
    let active = true;
    const { id: orderId, paymentId } = s.order;
    const currentPage = pageGuard();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const order = await api.getOrder(s.order?.connection ?? s.settings, orderId);
        if (!active || !currentPage()) return;
        if (!isOrder(order) || order.id !== orderId || order.paymentId !== paymentId)
          throw new Error('주문 정보가 일치하지 않아요.');
        dispatch({ type: 'ORDER_UPDATED', order });
        if (order.status === 'ready') return;
      } catch {
        if (active && currentPage()) dispatch({ type: 'ORDER_LOOKUP_FAILED', orderId });
      }
      if (active && currentPage()) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [s.flow, s.order?.id, s.settings, s.revision]);
  // Speech is initiated only by explicit listen/preview actions.
  const speak = (text: string) => Device.speak(text);
  function discover(demo = false) {
    const state = live.current;
    if (state.recoveryRequired || state.request || state.payment) {
      dispatch({ type: 'NAV', flow: 'P02-V' });
      return;
    }
    if (state.order) {
      dispatch({ type: 'OPEN_ORDER' });
      return;
    }
    // Ignore a duplicate click until React commits the first transition.
    if (discovery.current?.revision === state.revision + 1) return;
    discovery.current?.stop();
    const action = { type: 'DISCOVER' as const, demo };
    const next = reduce(state, action);
    dispatch(action);
    const stop = startDiscovery({
      settings: catalogConnection(next),
      demo,
      stores: state.stores,
      send: result => dispatch({ ...result, revision: next.revision }),
    });
    discovery.current = { revision: next.revision, stop };
  }
  async function voiceSearch() {
    if (voiceRequest.current) return;
    const request = new AbortController();
    voiceRequest.current = request;
    const { flow, revision } = live.current;
    const isCurrent = () => !request.signal.aborted &&
      live.current.flow === flow && live.current.revision === revision;
    // Clear an earlier message so the same one is announced again.
    dispatch({ type: 'START_VOICE_SEARCH' });
    setListening(true);
    try {
      Device.signal('listen');
      const text = (await Device.recognize(request.signal)).trim();
      if (!isCurrent()) return;
      if (text) {
        dispatch({ type: 'QUERY', value: text, spoken: true, revision });
        return;
      }
      dispatch({
        type: 'FAIL',
        flow, revision,
        message: '말씀을 듣지 못했어요. 말하기를 다시 눌러 주세요.',
      });
    } catch (e) {
      if (isCurrent()) dispatch({ type: 'FAIL', flow, revision, message: message(e) });
    } finally {
      if (voiceRequest.current === request) {
        voiceRequest.current = null;
        setListening(false);
      }
    }
  }
  async function complete(result: 'success' | 'cancel' | 'fail' | 'timeout') {
    const state = live.current;
    const payment = state.payment;
    if (completing.current || state.recoveryRequired || state.flow !== 'PAYMENT_EXTERNAL' ||
        payment?.state !== 'ready' || payment.provider === KAKAO_TEST_PROVIDER || !paymentMatchesRequest(payment, state.request)) return;
    const isCurrent = () => live.current.payment?.id === payment.id;
    completing.current = true;
    setBusy(true);
    try {
      const current = snapshot(state);
      await persist(current, isCurrent, current, true);
      if (!isCurrent()) return;
      const connection = payment.connection ?? state.request?.connection ?? state.settings;
      const response = await api.complete(connection, payment.id, result);
      if (!isPayment(response) || response.id !== payment.id)
        throw new Error('같은 결제의 결과를 확인하지 못했어요.');
      const action = await paymentResult(connection, payment.connection ? { ...response, connection: payment.connection } : response);
      if (isCurrent()) dispatch(action);
    } catch (e) {
      if (isCurrent() && !handleConflict(e)) dispatch({ type: 'FAIL', flow: 'P02-V', message: message(e) });
    } finally {
      completing.current = false;
      setBusy(false);
    }
  }
  async function returnToCart() {
    const state = live.current;
    const { payment, revision } = state;
    if (returningKakao.current || openingKakao.current || !payment?.cartReturnAvailable ||
        !['P02-V', 'PAYMENT_EXTERNAL'].includes(state.flow)) return;
    const currentPage = pageGuard();
    const isCurrent = () => currentPage() && live.current.revision === revision &&
      live.current.payment?.id === payment.id && live.current.request?.key === state.request?.key;

    returningKakao.current = true;
    kakaoDecision.current++;
    setBusy(true);
    setKakaoCheckStatus('checking');
    try {
      const result = await returnKakaoPaymentToCart(state, isCurrent);
      if (!isCurrent()) return;
      if (result) dispatch({ ...result, revision });
      setKakaoCheckStatus(result?.type === 'PAYMENT_RESULT' && !result.error ? 'checked' : 'unavailable');
    } catch (error) {
      if (isCurrent()) {
        if (state.flow === 'PAYMENT_EXTERNAL')
          dispatch({ type: 'FAIL', flow: 'P02-V', message: message(error), revision });
        setKakaoCheckStatus('unavailable');
      }
    } finally {
      returningKakao.current = false;
      setBusy(false);
    }
  }

  function leaveForKakaoCheckout() {
    if (returningKakao.current) return;
    const state = live.current;
    const currentPage = pageGuard();
    const isCurrent = () => !returningKakao.current && currentPage() && live.current.revision === state.revision &&
      live.current.payment?.id === state.payment?.id && canOpenKakaoPayment(live.current);
    return openKakaoCheckout(state, openingKakao, isCurrent, error => {
      dispatch({ type: 'STORAGE_ERROR', message: error });
    }).catch(error => { if (currentPage()) handleConflict(error); });
  }

  function finishPickup() {
    const state = live.current;
    const currentPage = pageGuard();
    return savePickup(state, pickingUp, setBusy, action => {
      if (!currentPage() || live.current.flow !== state.flow || live.current.order?.id !== state.order?.id) return;
      dispatch(action);
      if (action.type === 'PICKUP_COMPLETE') window.speechSynthesis?.cancel();
    }, currentPage).catch(error => { if (currentPage()) handleConflict(error); });
  }

  return {
    s,
    dispatch,
    busy: busy || checkingPayment,
    listening,
    kakaoCheckStatus,
    checkKakaoPayment: () => setKakaoCheckStatus(paymentWatcher.current?.checkNow() ? 'checking' : 'unavailable'),
    openKakaoCheckout: leaveForKakaoCheckout,
    returnKakaoToCart: returnToCart,
    speak,
    discover,
    voiceSearch,
    cancelVoiceSearch,
    complete,
    finishPickup,
  };
}
export async function savePickup(
  state: State,
  inFlight: { current: boolean },
  setBusy: (busy: boolean) => void,
  dispatch: (action: Action) => void,
  canWrite = () => true,
) {
  if (inFlight.current) return;
  const action = { type: 'PICKUP_COMPLETE' } as const;
  const finished = reduce(state, action);
  if (finished === state) return;

  inFlight.current = true;
  setBusy(true);
  try {
    try {
      await persist(snapshot(finished), canWrite, snapshot(state), true);
    } catch (error) {
      if (error instanceof SnapshotConflict) throw error;
      dispatch({
        type: 'STORAGE_ERROR',
        message: '픽업 완료를 저장하지 못했어요. 저장 공간을 확인한 뒤 다시 눌러 주세요.',
      });
      return;
    }
    dispatch(action);
  } finally {
    inFlight.current = false;
    setBusy(false);
  }
}

function message(e: unknown) {
  return e instanceof Error ? e.message : '다시 시도해 주세요.';
}
