import { paymentMatchesRequest, sameQuote } from '../core/domain';
import { snapshot, type Action } from '../core/flow';
import { isOrder, isPayment } from '../core/savedData';
import { KAKAO_TEST_PROVIDER, type Connection, type Payment, type State } from '../core/types';
import * as api from './api';
import { persist } from './storage';
import * as Device from '../native/browserDevice';
import { paymentChannel } from '../native/paymentChannel';

const message = (error: unknown) =>
  error instanceof Error ? error.message : '결제 상태를 다시 확인해 주세요.';

export function canOpenKakaoPayment(state: State, channel = paymentChannel(globalThis.navigator)) {
  const payment = state.payment;
  return !state.recoveryRequired && !state.error && payment?.provider === KAKAO_TEST_PROVIDER &&
    payment.connection?.mode === KAKAO_TEST_PROVIDER &&
    payment.state === 'ready' && !!payment.redirect && payment.checkoutAvailable?.[channel] !== false &&
    paymentMatchesRequest(payment, state.request);
}

export async function openKakaoCheckout(
  state: State,
  opening: { current: boolean },
  isCurrent: () => boolean,
  showError: (message: string) => void,
) {
  const channel = paymentChannel(globalThis.navigator);
  const payment = state.payment;
  const connection = payment?.connection;
  if (opening.current || !payment?.redirect || connection?.mode !== KAKAO_TEST_PROVIDER ||
      !['PAYMENT_EXTERNAL', 'P02-V'].includes(state.flow) || !canOpenKakaoPayment(state, channel)) return;

  opening.current = true;
  let leaving = false;
  try {
    try {
      await persist(snapshot(state), isCurrent);
    } catch {
      if (isCurrent()) showError('결제 복구 정보를 저장하지 못했어요. 다시 시도해 주세요.');
      return;
    }
    if (!isCurrent()) return;
    Device.openKakaoPayment(payment.redirect, connection.serverUrl, payment.id, channel);
    leaving = true;
  } catch (error) {
    if (isCurrent()) showError(message(error));
  } finally {
    if (!leaving) opening.current = false;
  }
}

export async function paymentResult(connection: Connection, payment: Payment): Promise<Action> {
  if (payment.state !== 'approved') return { type: 'PAYMENT_RESULT', payment };
  try {
    if (!payment.orderId) throw new Error('아직 주문번호를 확인할 수 없어요.');
    const order = await api.getOrder(payment.connection ?? connection, payment.orderId);
    if (!isOrder(order) || order.id !== payment.orderId || order.paymentId !== payment.id ||
        !sameQuote(order.snapshot, payment.snapshot))
      throw new Error('저장된 결제와 일치하는 주문을 확인하지 못했어요.');
    return { type: 'PAYMENT_RESULT', payment, order: payment.connection ? { ...order, connection: payment.connection } : order };
  } catch (error) {
    return { type: 'PAYMENT_RESULT', payment, error: message(error) };
  }
}

export async function advancePayment(
  state: State,
  isCurrent: () => boolean,
): Promise<Action | undefined> {
  if (state.recoveryRequired) return;
  const { settings, request } = state;
  const pinned = request?.connection ?? state.payment?.connection;
  const connection = pinned ?? settings;
  const kakao = connection.mode === KAKAO_TEST_PROVIDER;
  const preparing = state.flow === 'V5-09';
  let payment = state.payment;
  let submitted = !preparing;

  function verifyQuote(payment: Payment) {
    if ((payment.state === 'ready' || kakao) && (!paymentMatchesRequest(payment, request) ||
        (kakao && state.payment && !sameQuote(state.payment.snapshot, payment.snapshot))))
      throw new Error('이전 주문과 결제 금액이 일치하지 않아요. 결제 내역을 확인하고 직원에게 문의해 주세요.');
  }

  function checkedPayment(response: unknown, id?: string): Payment {
    if (!isPayment(response) || (id && response.id !== id) || (kakao && response.provider !== KAKAO_TEST_PROVIDER))
      throw new Error('같은 결제의 결과를 확인하지 못했어요.');
    return pinned ? { ...response, connection: pinned } : response;
  }

  async function storeBeforeOpening(payment: Payment) {
    if (kakao && payment.state === 'ready') {
      if (!payment.redirect) throw new Error('카카오페이 결제창을 확인하지 못했어요.');
      try {
        await persist(snapshot({ ...state, payment }), isCurrent);
      } catch {
        throw new Error('결제 복구 정보를 저장하지 못했어요. 다시 확인해 주세요.');
      }
    }
  }

  async function changedQuote(): Promise<Action> {
    const quote = await api.revalidate(connection, request!);
    const products = await api.getMenu(connection, request!.storeId);
    return { type: 'PRICE_CHANGED', quote, products };
  }

  async function checkoutRejected(error: unknown): Promise<Action> {
    const products = request && isCurrent()
      ? await api.getMenu(connection, request.storeId).catch(() => undefined)
      : undefined;
    return { type: 'CHECKOUT_REJECTED', products, message: message(error) };
  }

  try {
    if (!payment) {
      // Only replay a request without a payment ID after an explicit retry.
      if (!request || (!preparing && !state.retryVerification)) return;
      await persist(snapshot(state), isCurrent);
      if (!isCurrent()) return;
      if (preparing) {
        const quote = await api.revalidate(connection, request);
        if (!isCurrent()) return;
        if (!sameQuote(quote, request.expected)) {
          const products = await api.getMenu(connection, request.storeId);
          return { type: 'PRICE_CHANGED', quote, products };
        }
      }

      submitted = true;
      const response = await api.prepare(connection, request);
      if (!isCurrent()) return;
      payment = checkedPayment(response);
      verifyQuote(payment);
      if (kakao && payment.failureReason === 'preparation') return { type: 'PAYMENT_RESULT', payment };
      if (preparing && payment.state === 'ready') {
        await storeBeforeOpening(payment);
        if (isCurrent()) return { type: 'PAYMENT_READY', payment };
        return;
      }
    }

    // A known approval survives both stale payment responses and a failed order lookup.
    if (payment.state !== 'approved' || !payment.orderId) {
      const response = await api.getPayment(connection, payment.id);
      if (!isCurrent()) return;
      const result = checkedPayment(response, payment.id);
      if (payment.state !== 'approved' || result.state === 'approved') {
        if (kakao) verifyQuote(result);
        payment = result;
      }
    }
    verifyQuote(payment);
    if (isCurrent()) return await paymentResult(connection, payment);
  } catch (error) {
    if (!isCurrent()) return;
    if (preparing && request && !payment &&
        error instanceof api.ApiError && error.reason === 'PRICE_CHANGED') {
      // The initial request was explicitly rejected by the price check.
      return await changedQuote().catch(checkoutRejected);
    }
    if (!submitted) return await checkoutRejected(error);

    // A receipt ID is useful even if the status call failed after preparation.
    // Never manufacture a failed status for an unknown response.
    if (payment) return { type: 'PAYMENT_RESULT', payment, error: message(error) };
    return { type: 'FAIL', flow: 'P02-V', message: message(error) };
  }
}
