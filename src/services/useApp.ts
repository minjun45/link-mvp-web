import { useEffect, useReducer, useRef, useState } from 'react';
import { initial, reduce, snapshot, type Action } from '../core/flow';
import type { State } from '../core/types';
import { paymentMatchesRequest } from '../core/domain';
import { isOrder, isPayment } from '../core/savedData';
import * as Device from '../native/browserDevice';
import { persist, readSnapshot } from './storage';
import * as api from './api';
import { startDiscovery } from './discovery';
import { advancePayment, paymentResult } from './checkout';

export function useApp() {
  const [s, dispatch] = useReducer(reduce, initial);
  const live = useRef(s);
  live.current = s;
  const [busy, setBusy] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);
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
    readSnapshot()
      .then(saved => {
        if (active)
          dispatch({
            type: 'HYDRATE',
            snapshot: saved,
            stores: api.stores,
            products: api.products,
          });
      })
      .catch(() => {
        if (active) {
          dispatch({
            type: 'HYDRATE',
            snapshot: null,
            stores: api.stores,
            products: api.products,
          });
        }
      });
    return () => {
      active = false;
      discovery.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);
  useEffect(() => {
    if (s.flow !== 'BOOT' && s.flow !== 'V5-13' && !s.recoveryRequired)
      persist(snapshot(s)).catch(() =>
        dispatch({
          type: 'STORAGE_ERROR',
          message: '기기에 주문 내용을 저장하지 못했어요. 새로고침 전에 저장 공간을 확인해 주세요.',
        }),
      );
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
  ]);
  useEffect(() => {
    if (s.signal) Device.signal(s.signal);
  }, [s.signal, s.revision]);
  useEffect(() => {
    let cancelled = false;
    const state = s;
    const isCurrent = () => !cancelled && live.current.revision === state.revision;
    const checkPayment = !state.recoveryRequired && (
      state.flow === 'V5-09' ||
      (state.flow === 'P02-V' && (!!state.payment || state.retryVerification))
    );
    setCheckingPayment(checkPayment);
    const send = (action: Parameters<typeof dispatch>[0]) => {
      if (isCurrent()) dispatch(action);
    };
    async function run() {
      if (state.flow === 'START' && !state.order && !state.request && !state.payment && !state.recoveryRequired) {
        try {
          send({ type: 'STORES', stores: await api.getStores(state.settings) });
        } catch (e) {
          send({ type: 'FAIL', flow: 'START', message: message(e) });
        }
      } else if (state.flow === 'V5-04') {
        try {
          send({
            type: 'MENU_LOADED',
            products: await api.getMenu(state.settings, state.storeId!),
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
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const order = await api.getOrder(s.settings, orderId);
        if (!active) return;
        if (!isOrder(order) || order.id !== orderId || order.paymentId !== paymentId)
          throw new Error('주문 정보가 일치하지 않아요.');
        dispatch({ type: 'ORDER_UPDATED', order });
        if (order.status === 'ready') return;
      } catch {
        if (active) dispatch({ type: 'ORDER_LOOKUP_FAILED', orderId });
      }
      if (active) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [s.flow, s.order?.id, s.settings]);
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
      settings: next.settings,
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
        payment?.state !== 'ready' || !paymentMatchesRequest(payment, state.request)) return;
    const isCurrent = () => live.current.payment?.id === payment.id;
    completing.current = true;
    setBusy(true);
    try {
      await persist(snapshot(state));
      if (!isCurrent()) return;
      const response = await api.complete(state.settings, payment.id, result);
      if (!isPayment(response) || response.id !== payment.id)
        throw new Error('같은 결제의 결과를 확인하지 못했어요.');
      const action = await paymentResult(state.settings, response);
      if (isCurrent()) dispatch(action);
    } catch (e) {
      if (isCurrent()) dispatch({ type: 'FAIL', flow: 'P02-V', message: message(e) });
    } finally {
      completing.current = false;
      setBusy(false);
    }
  }
  function finishPickup() {
    const state = live.current;
    return savePickup(state, pickingUp, setBusy, action => {
      if (live.current.flow !== state.flow || live.current.order?.id !== state.order?.id) return;
      dispatch(action);
      if (action.type === 'PICKUP_COMPLETE') window.speechSynthesis?.cancel();
    });
  }

  return {
    s,
    dispatch,
    busy: busy || checkingPayment,
    listening,
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
) {
  if (inFlight.current) return;
  const action = { type: 'PICKUP_COMPLETE' } as const;
  const finished = reduce(state, action);
  if (finished === state) return;

  inFlight.current = true;
  setBusy(true);
  try {
    try {
      await persist(snapshot(finished));
    } catch {
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
