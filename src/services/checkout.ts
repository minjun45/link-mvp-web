import { paymentMatchesRequest, sameQuote } from '../core/domain';
import { snapshot, type Action } from '../core/flow';
import { isOrder, isPayment } from '../core/savedData';
import type { Payment, Settings, State } from '../core/types';
import * as api from './api';
import { persist } from './storage';

const message = (error: unknown) =>
  error instanceof Error ? error.message : '결제 상태를 다시 확인해 주세요.';

export async function paymentResult(settings: Settings, payment: Payment): Promise<Action> {
  if (payment.state !== 'approved') return { type: 'PAYMENT_RESULT', payment };
  try {
    if (!payment.orderId) throw new Error('아직 주문번호를 확인할 수 없어요.');
    const order = await api.getOrder(settings, payment.orderId);
    if (!isOrder(order) || order.id !== payment.orderId || order.paymentId !== payment.id ||
        !sameQuote(order.snapshot, payment.snapshot))
      throw new Error('저장된 결제와 일치하는 주문을 확인하지 못했어요.');
    return { type: 'PAYMENT_RESULT', payment, order };
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
  const preparing = state.flow === 'V5-09';
  let payment = state.payment;
  let submitted = !preparing;

  function verifyReadyQuote(payment: Payment) {
    if (payment.state === 'ready' && !paymentMatchesRequest(payment, request))
      throw new Error('이전 주문과 결제 금액이 일치하지 않아요. 결제 내역을 확인하고 직원에게 문의해 주세요.');
  }

  async function changedQuote(): Promise<Action> {
    const quote = await api.revalidate(settings, request!);
    const products = await api.getMenu(settings, request!.storeId);
    return { type: 'PRICE_CHANGED', quote, products };
  }

  async function checkoutRejected(error: unknown): Promise<Action> {
    const products = request && isCurrent()
      ? await api.getMenu(settings, request.storeId).catch(() => undefined)
      : undefined;
    return { type: 'CHECKOUT_REJECTED', products, message: message(error) };
  }

  try {
    if (!payment) {
      // Only replay a request without a payment ID after an explicit retry.
      if (!request || (!preparing && !state.retryVerification)) return;
      await persist(snapshot(state));
      if (!isCurrent()) return;
      if (preparing) {
        const quote = await api.revalidate(settings, request);
        if (!isCurrent()) return;
        if (!sameQuote(quote, request.expected)) {
          const products = await api.getMenu(settings, request.storeId);
          return { type: 'PRICE_CHANGED', quote, products };
        }
      }

      submitted = true;
      const response = await api.prepare(settings, request);
      if (!isCurrent()) return;
      if (!isPayment(response)) throw new Error('결제 정보를 확인할 수 없어요.');
      payment = response;
      verifyReadyQuote(payment);
      if (preparing && payment.state === 'ready') return { type: 'PAYMENT_READY', payment };
    }

    // A known approval survives both stale payment responses and a failed order lookup.
    if (payment.state !== 'approved' || !payment.orderId) {
      const result = await api.getPayment(settings, payment.id);
      if (!isCurrent()) return;
      if (!isPayment(result) || result.id !== payment.id)
        throw new Error('같은 결제의 결과를 확인하지 못했어요.');
      if (payment.state !== 'approved' || result.state === 'approved') payment = result;
    }
    verifyReadyQuote(payment);
    return await paymentResult(settings, payment);
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
