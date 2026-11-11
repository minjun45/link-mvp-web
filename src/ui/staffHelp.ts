import { money } from '../core/domain';
import type { Quote, State } from '../core/types';

export function staffHelpText(s: State, cartQuote?: Quote): string {
  switch (s.flow) {
    case 'V5-01':
    case 'V5-01e':
    case 'V5-02':
    case 'V5-02e':
    case 'V5-02s':
    case 'E01':
    case 'E02':
    case 'E03':
      return '매장을 찾고 있어요. 이곳에서 휴대폰으로 주문할 수 있는지 확인해 주세요.';
    case 'V5-03': {
      const store = s.stores.find(item => item.id === s.selectedStoreId);
      return store
        ? `지금 있는 곳이 ${store.name}인지 확인해 주세요.`
        : '주문할 매장을 찾을 수 있게 도와주세요.';
    }
    case 'V5-04':
    case 'V5-M1':
    case 'V5-05':
      return '메뉴를 고르고 있어요. 주문할 수 있는 메뉴를 안내해 주세요.';
    case 'V5-R1':
      return '지난 주문을 다시 담으려고 해요. 메뉴와 옵션을 함께 확인해 주세요.';
    case 'V5-06':
    case 'V5-06s':
    case 'V5-08e':
    case 'V5-M3':
    case 'V5-M4': {
      const name = s.products.find(item => item.id === s.productId)?.name;
      return `${name ? `${name} 메뉴의` : '메뉴의'} 옵션과 수량을 고를 수 있게 도와주세요.`;
    }
    case 'V5-05c':
    case 'V5-08': {
      if (!s.cart.length) return '장바구니가 비어 있어요. 메뉴를 담을 수 있게 도와주세요.';
      if (!cartQuote) return '담은 메뉴의 옵션과 가격을 다시 확인해 주세요.';
      const lines = cartQuote.items.map(item =>
        [item.name, ...item.labels, `${item.quantity}개`].join(' · '),
      );
      return [cartQuote.storeName, ...lines, `합계 ${money(cartQuote.total)}입니다. 결제 전에 함께 확인해 주세요.`].join('\n');
    }
    case 'P01-E1':
      return '주문 내용이 바뀌었어요. 결제 전에 메뉴와 금액을 함께 확인해 주세요.';
    case 'V5-09':
    case 'PAYMENT_EXTERNAL':
    case 'P02-V':
      return '결제를 진행하고 있어요. 현재 결제 상태를 함께 확인해 주세요.';
    case 'P01-E2':
    case 'P02-C':
    case 'P02-F':
    case 'P02-T':
      return '결제를 마치지 못했어요. 결제 상태와 주문 방법을 확인해 주세요.';
    case 'V5-10':
    case 'V5-11':
    case 'V5-12': {
      const request = s.flow === 'V5-12'
        ? '주문한 메뉴를 받는 위치로 안내해 주세요.'
        : '제 주문의 준비 상태를 확인해 주세요.';
      return s.order
        ? `${s.order.demo ? '테스트 주문번호' : '주문번호'} ${s.order.number}입니다. ${request}`
        : request;
    }
    case 'E04':
    case 'E05':
      return '휴대폰으로 주문을 진행하기 어려워요. 이 매장에서 이용할 수 있는 주문 방법을 안내해 주세요.';
    default:
      return '이곳에서 휴대폰으로 주문하고 싶어요. 주문을 시작할 수 있게 도와주세요.';
  }
}
