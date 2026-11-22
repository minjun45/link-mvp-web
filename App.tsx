import React, { useContext, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useApp } from './src/services/useApp';
import {
  Button,
  Card,
  T,
  ThemeContext,
  fontFamily,
  light,
  styles as st,
} from './src/ui/kit';
import { titles, topLabels } from './src/ui/content';
import {
  CartBar,
  ChoiceInput,
  Icon,
  InfoRow,
  NavigationRow,
  OptionRow,
  Photo,
  Stepper,
} from './src/ui/figma';
import type { Group, PricedLine, Quote, Settings } from './src/core/types';
import { frequent, fromOrder, key, money, quote } from './src/core/domain';
import * as Device from './src/native/browserDevice';
import { useAppDialog } from './src/ui/dialog';
import { staffHelpText } from './src/ui/staffHelp';

type ActionButton = {
  label: string;
  run: () => void;
  disabled?: boolean;
  neutral?: boolean;
};
function menuSearchKey(text: string) {
  return text.replace(/\s+/g, '').replace(/라떼/g, '라테');
}

function unitFor(category?: string) {
  return category === '커피' || category === '음료' ? '잔' : '개';
}

export default function App() {
  const app = useApp();
  const { s, dispatch: d } = app;
  const { height, fontScale } = useWindowDimensions();
  const theme = {
    ...light,
    ...(s.settings.dark
      ? {
          bg: '#121416',
          card: '#222629',
          text: '#FFFFFF',
          muted: '#C5C9CE',
          line: '#72777D',
          selected: '#51481B',
          danger: '#FFADB3',
        }
      : {}),
    ...(s.settings.contrast
      ? {
          line: s.settings.dark ? '#FFFFFF' : '#111111',
          muted: s.settings.dark ? '#FFFFFF' : '#111111',
        }
      : {}),
    scale: s.settings.large ? 1 : 0.9,
    contrast: s.settings.contrast,
  };
  const { alert, helpCard, dialog } = useAppDialog(theme);
  const entryScreen = ['START', 'BLE_GUIDE', 'V5-01', 'V5-01e', 'V5-02', 'V5-02e', 'V5-02s', 'V5-03', 'V5-04'].includes(s.flow);
  const heading = useRef<React.ComponentRef<typeof Text>>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [hasMore, setHasMore] = useState(false);
  const [titleScrolled, setTitleScrolled] = useState(false);
  useEffect(() => {
    const viewport = scroll.current;
    const surface = content.current;
    if (!viewport || !surface) return;
    const measure = () => {
      setHasMore(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 2);
      const rect = (heading.current as unknown as HTMLElement | null)?.getBoundingClientRect();
      setTitleScrolled(!!rect && rect.bottom <= viewport.getBoundingClientRect().top);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(surface);
    viewport.addEventListener('scroll', measure, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [s.flow, s.revision]);
  const store = s.stores.find(
    x => x.id === (s.flow === 'V5-03' ? s.selectedStoreId : s.storeId),
  );
  const categories = [...new Set(s.products.map(p => p.category))];
  const wizardGroup = s.products.find(p => p.id === s.productId)?.options[
    s.step
  ];
  const title =
    s.flow === 'V5-M3'
      ? `${wizardGroup?.name || '옵션'}을 골라 주세요`
      : s.flow === 'V5-02'
      ? `매장 ${s.found.length}곳을 찾았어요`
      : s.flow === 'V5-05' && store
      ? store.name
      : ['V5-06', 'V5-08e', 'V5-05c'].includes(s.flow)
      ? s.products.find(p => p.id === s.productId)?.name || titles[s.flow]
      : s.flow === 'V5-08' ? '장바구니'
      : titles[s.flow];
  const product = s.products.find(x => x.id === s.productId);
  const selectedTotal = product
    ? (product.price +
        product.options.reduce(
          (n, g) =>
            n + (g.choices.find(c => c.id === s.selected[g.id])?.price || 0),
          0,
        )) *
      s.quantity
    : 0;
  let cartQuote: Quote | undefined;
  let cartError = '';
  try {
    if (s.cart.length)
      cartQuote = quote(
        s.stores.find(x => x.id === s.storeId),
        s.products,
        s.cart,
      );
  } catch (e) {
    cartError = e instanceof Error ? e.message : '';
  }
  const help = () => {
    const message = staffHelpText(s, cartQuote);
    helpCard(message, () => app.speak(message));
  };
  const nav = (flow: typeof s.flow) => d({ type: 'NAV', flow });
  const menu = () => nav(s.products.length > 20 ? 'V5-M1' : 'V5-05');
  const checkout = (reorder = false) =>
    d({ type: 'CHECKOUT', key: key(), reorder });
  const discover = () => s.discovery === 'demo'
    ? app.discover(true)
    : nav('BLE_GUIDE');
  const add = () => d({ type: 'ADD', id: key() });
  useEffect(() => {
    // The browser owns focus while its Bluetooth device chooser is open.
    if ((s.flow === 'V5-01' && s.discovery === 'ble') || s.flow === 'V5-05c') return;

    scroll.current?.scrollTo({ top: 0 });
    const titleNode = heading.current as unknown as HTMLElement | null;
    titleNode?.setAttribute('tabindex', '-1');
    titleNode?.focus({ preventScroll: true });
  }, [s.flow, s.revision]);
  useEffect(() => {
    if (s.error === 'CHANGE_STORE')
      alert(
        '다른 매장으로 바꿀까요?',
        '기존 매장에서 담은 메뉴가 비워져요.',
        [
          { text: '유지하기', onPress: () => d({ type: 'CLEAR_ERROR' }) },
          {
            text: '비우고 매장 바꾸기',
            onPress: () => d({ type: 'CONFIRM_STORE', clear: true }),
          },
        ],
        () => d({ type: 'CLEAR_ERROR' }),
      );
  }, [s.error]);
  const search = (placeholder: string, label = placeholder) => (
    <View
      style={[
        st.input,
        st.row,
        {
          backgroundColor: theme.card,
          borderColor: theme.text,
          paddingLeft: entryScreen ? 16 : 8,
          paddingRight: 8,
          paddingVertical: 6,
          borderWidth: 2,
        },
      ]}
    >
      <Icon name="search" size={26} color={theme.text} />
      {/* The hint is drawn as hidden text, not a native placeholder, so
          screen readers announce the field name once instead of twice. */}
      <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
        {!s.query && (
          <Text
            aria-hidden
            pointerEvents="none"
            numberOfLines={1}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              color: theme.muted,
              fontFamily,
              fontSize: 19 * theme.scale,
            }}
          >
            {placeholder}
          </Text>
        )}
        <TextInput
          value={s.query}
          onChangeText={value => d({ type: 'QUERY', value })}
          accessibilityLabel={label}
          style={{
            minWidth: 0,
            color: theme.text,
            fontFamily,
            fontSize: 19 * theme.scale,
            padding: 0,
            minHeight: 48,
          }}
          returnKeyType="search"
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="말하기"
        onPress={app.voiceSearch}
        style={({ pressed }) => ({
          minHeight: 48,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 10,
          borderRadius: 12,
          backgroundColor: '#FEE500',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Icon name="mic" size={20} color="#191919" />
        <T
          style={{
            color: '#191919',
            fontSize: 16 * theme.scale,
            fontWeight: '700',
          }}
        >
          말하기
        </T>
      </Pressable>
    </View>
  );
  const subtitle = (text: string) => (
    <T
      style={{
        color: theme.muted,
        fontSize: 21 * theme.scale,
        lineHeight: 29.4 * theme.scale,
      }}
    >
      {text}
    </T>
  );
  const sectionLabel = (text: string) => (
    <h2 className="section-heading" style={{ fontSize: 20 * theme.scale }}>{text}</h2>
  );
  const options = (groups: Group[]) => (
    <View style={st.stack}>
      {groups.map(g => (
        <View
          key={g.id}
          style={st.stack}
          accessibilityRole="radiogroup"
          accessibilityLabel={`${g.name} · ${g.required ? '필수' : '선택'}`}
        >
          {sectionLabel(
            `${g.name} · ${g.required ? '필수' : '선택'}`,
          )}
          {s.missingGroup === g.id && (
            <T style={{ color: theme.danger }}>먼저 선택해 주세요.</T>
          )}
          {g.choices.map(c => {
            const temperature =
              g.id === 'temperature' && (c.id === 'ice' || c.id === 'hot');
            return (
              <OptionRow
                key={c.id}
                name={`option-${g.id}`}
                label={temperature ? c.id.toUpperCase() : c.name}
                detail={temperature ? c.name : `+${money(c.price)}`}
                selected={s.selected[g.id] === c.id}
                onPress={() => d({ type: 'OPTION', id: g.id, value: c.id })}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
  const unit = unitFor(product?.category);
  const quantity = (
    <View style={st.stack}>
      {sectionLabel('수량')}
      <Stepper
        quantity={s.quantity}
        unit={unit}
        onChange={value => d({ type: 'QUANTITY', value })}
      />
    </View>
  );
  const productHeading = ['V5-06', 'V5-08e', 'V5-05c'].includes(s.flow);
  const productSummary = product && (
    <>
      {!productHeading && <><Photo large /><T kind="title">{product.name}</T></>}
      <T style={{ fontSize: 20 * theme.scale, fontWeight: '700' }}>
        기본 {money(product.price)}
      </T>
      {subtitle(product.description)}
    </>
  );
  const selectionSummary = product && (
    <Card>
      <T kind="section">
        {product.name} {s.quantity}개
      </T>
      <T>
        {product.options
          .map(
            g =>
              `${g.name} ${
                g.choices.find(c => c.id === s.selected[g.id])?.name ||
                '선택 전'
              }`,
          )
          .join(', ')}
      </T>
      <T kind="section">
        {money(
          (product.price +
            product.options.reduce(
              (n, g) =>
                n +
                (g.choices.find(c => c.id === s.selected[g.id])?.price || 0),
              0,
            )) *
            s.quantity,
        )}
      </T>
    </Card>
  );
  let body: React.ReactNode;
  let searchStatus = '';
  let primary: ActionButton | undefined;
  let secondary: ActionButton[] = [];
  switch (s.flow) {
    case 'BOOT':
      body = <ActivityIndicator size="large" />;
      break;
    case 'START':
      body = (
        <>
          {subtitle('실제 매장을 찾거나 데모로 먼저 체험해 보세요.')}
          <Card compact>
            <InfoRow icon="store" label="실제 매장 찾기" value="블루투스로 주변 매장을 찾아요" />
            <InfoRow icon="cup" label="데모 매장으로 진행하기" value="실제 결제 없이 주문을 체험해요" />
          </Card>
          {!s.discoveryReady && !s.error && <T kind="small">매장 정보를 확인하고 있어요.</T>}
          {!!s.error && <Button label="매장 정보 다시 불러오기" onPress={() => nav('START')} />}
        </>
      );
      primary = {
        label: '실제 매장 찾기',
        run: () => nav('BLE_GUIDE'),
        disabled: !s.discoveryReady,
      };
      secondary = [{ label: '데모 매장으로 진행하기', run: () => app.discover(true) }];
      break;
    case 'BLE_GUIDE':
      body = subtitle('다음 창에서 매장 기기를 선택해 주세요. 웹 주소가 먼저 읽힐 수 있어요.');
      primary = {
        label: '기기 선택 창 열기',
        run: () => app.discover(false),
      };
      secondary = [{ label: '매장 이름으로 찾기', run: () => nav('V5-02s') }];
      break;
    case 'V5-O1':
      body = (
        <>
          {subtitle('처음 한 번만, 1분이면 돼요.')}
          {sectionLabel('배울 것 3가지')}
          <Card compact>
            <InfoRow
              icon="store"
              label="1 · 화면 구조"
              value="어디를 누르면 되는지"
            />
            <InfoRow
              icon="speaker"
              label="2 · 진동과 소리"
              value="신호 4가지 미리 듣기"
            />
            <InfoRow icon="bag" label="3 · 연습" value="버튼 한 번 눌러 보기" />
          </Card>
        </>
      );
      primary = {
        label: '사용법 듣기 · 약 1분',
        run: () => d({ type: 'ONBOARD_NEXT' }),
      };
      secondary = [
        { label: '건너뛰기', run: () => d({ type: 'ONBOARD_SKIP' }) },
      ];
      break;
    case 'V5-O2':
      body = (
        <>
          {subtitle('모든 화면은 같은 세 구역으로 되어 있어요.')}
          {sectionLabel('화면은 늘 세 구역')}
          <Card compact>
            <InfoRow
              icon="store"
              label="화면 제목"
              value="지금 무슨 화면인지"
            />
            <InfoRow
              icon="cup"
              label="화면 내용"
              value="매장 정보 · 메뉴 · 선택지"
            />
            <InfoRow
              icon="bag"
              label="주요 버튼"
              value="다음 단계로 가기"
            />
            <InfoRow
              icon="staff"
              label="직원 도움"
              value="설정에서 ‘직원에게 보여주기’를 켜면 사용할 수 있어요"
            />
          </Card>
        </>
      );
      primary = {
        label: '다음 · 진동과 소리',
        run: () => d({ type: 'ONBOARD_NEXT' }),
      };
      break;
    case 'V5-O3':
      body = (
        <>
          {subtitle('신호 4가지를 눌러서 직접 느껴 보세요.')}
          {sectionLabel('신호 4가지 · 눌러서 들어보기')}
          {[
            ['found', '매장을 찾았어요', '찾았을 때 울리는 신호'],
            ['selected', '선택했어요', '메뉴와 옵션 선택 신호'],
            ['success', '결제가 끝났어요', '완료 진동과 소리'],
            ['found', '음료가 준비됐어요', '앱에서 준비 완료 안내'],
          ].map(([kind, label, description]) => (
            <NavigationRow
              key={label}
              icon="speaker"
              title={label}
              description={description}
              tag="들어보기"
              onPress={() => {
                Device.signal(kind);
                app.speak(label);
              }}
            />
          ))}
        </>
      );
      primary = {
        label: '다음 · 연습해 보기',
        run: () => d({ type: 'ONBOARD_NEXT' }),
      };
      break;
    case 'V5-O4':
      body = (
        <>
          {subtitle('‘연습 · 여기를 눌러 보기’ 버튼을 눌러 보세요.')}
          {sectionLabel('연습이 끝나면')}
          <Card compact>
            <InfoRow icon="bag" label="성공하면" value="가벼운 진동과 안내" />
            <InfoRow
              icon="staff"
              label="나중에 또 배우려면"
              value="설정 › 사용법 다시 듣기"
            />
          </Card>
        </>
      );
      primary = {
        label: '연습 · 여기를 눌러 보기',
        run: () => {
          Device.signal('selected');
          app.speak('잘하셨어요');
          d({ type: 'ONBOARD_NEXT' });
        },
      };
      secondary = [
        { label: '건너뛰고 매장 찾기', run: () => d({ type: 'ONBOARD_NEXT' }) },
      ];
      break;
    case 'V5-01':
      body = (
        <>
          {subtitle(s.discovery === 'demo'
            ? '매장 입구 근처에서 잠시 기다려 주세요. 찾으면 진동으로 알려드려요.'
            : '브라우저 창에서 매장 기기를 선택해 주세요.')}
          <Card compact>
            <InfoRow
              icon="store"
              label="블루투스"
              value={s.discovery === 'demo'
                ? '데모 매장 확인 중'
                : '주변 기기 확인 중'}
            />
          </Card>
        </>
      );
      primary = { label: '찾기 멈추기', neutral: true, run: () => nav('V5-02e') };
      break;
    case 'E01':
    case 'E02': {
      const canChoose = Device.canChooseBeacon();
      const findByName = { label: '매장 이름으로 찾기', run: () => nav('V5-02s') };
      body = <Card><T>{s.error}</T></Card>;
      primary = canChoose
        ? { label: '다시 찾기', run: discover }
        : findByName;
      secondary = canChoose ? [findByName] : [];
      break;
    }
    case 'V5-01e':
    case 'E03':
      body = subtitle('매장 입구 가까이 이동한 뒤 다시 찾아 주세요. 주문을 지원하는 매장만 찾을 수 있어요.');
      primary = { label: '다시 찾기', run: discover };
      secondary = [{ label: '매장 이름으로 찾기', run: () => nav('V5-02s') }];
      break;
    case 'V5-02e': {
      body = (
        <>
          {subtitle('아래 방법을 위에서부터 차례로 해 보세요.')}
          <NavigationRow
            icon="radar"
            title="다시 찾기"
            description="입구 쪽으로 몇 걸음 다가간 뒤"
            onPress={discover}
          />
          <NavigationRow
            icon="search"
            title="매장 이름으로 찾기"
            description="참여 매장 전체에서 검색"
            onPress={() => nav('V5-02s')}
          />
          <NavigationRow
            icon="staff"
            title="주변 사람에게 도움 요청"
            description="큰 글씨 도움 카드를 화면에 띄워요"
            onPress={help}
          />
          <Card compact>
            <InfoRow icon="store" label="안내" value="휴대폰 주문을 지원하는 매장만 목록에 나와요" />
          </Card>
        </>
      );
      break;
    }
    case 'E04':
    case 'E05':
      body = (
        <Card>
          <T>{s.error || '연결 상태를 확인해 주세요.'}</T>
          <T>장바구니에 담은 메뉴는 유지돼요.</T>
        </Card>
      );
      primary = {
        label: s.flow === 'E05' ? '다른 매장 찾기' : s.storeId ? '메뉴 다시 불러오기' : '매장 다시 찾기',
        run: () => s.flow === 'E05' ? nav('V5-02s') : s.storeId ? nav('V5-04') : discover(),
      };
      secondary = [{ label: '매장 이름으로 찾기', run: () => nav('V5-02s') }];
      break;
    case 'V5-02':
    case 'V5-02s': {
      const nearby = s.flow === 'V5-02';
      const list = (nearby ? s.found : s.stores).filter(x => x.name.includes(s.query.trim()));
      if (s.query.trim())
        searchStatus = list.length ? `매장 검색 결과 ${list.length}곳` : '일치하는 매장이 없어요.';
      body = (
        <>
          {nearby && s.found[0] && subtitle(s.discovery === 'demo'
            ? '데모 매장을 선택해 주세요.'
            : `${s.found[0].name}을 찾았어요.`)}
          {search('매장 이름으로 찾기')}
          {sectionLabel(nearby && !s.query
            ? `찾은 매장 · ${list.length}곳`
            : nearby ? '매장 검색 결과' : `참여 매장 · ${list.length}곳`)}
          {list.slice(0, s.storeLimit).map(x => (
            <NavigationRow
              key={x.id}
              icon="store"
              title={x.name}
              description={x.open ? x.address : '오늘 주문 마감'}
              onPress={() => d({ type: 'SELECT_STORE', id: x.id })}
            />
          ))}
          {!list.length && <T>일치하는 매장이 없어요.</T>}
          {list.length > s.storeLimit && (
            <Button
              label={`다른 매장 ${Math.min(3, list.length - s.storeLimit)}곳 더 보기`}
              onPress={() => d({ type: 'MORE_STORES' })}
            />
          )}
          {!nearby && (
            <Card compact>
              <InfoRow icon="staff" label="휴대폰 주문 미지원" value="찾는 매장이 없다면 직원 도움이나 전화로 주문해 주세요" />
            </Card>
          )}
        </>
      );
      primary = nearby ? {
        label: '찾는 매장이 없어요',
        neutral: true,
        run: () => nav('V5-02e'),
      } : undefined;
      break;
    }
    case 'V5-03':
      primary = store ? { label: '이 매장에서 주문', run: () => d({ type: 'CONFIRM_STORE' }) } : undefined;
      body = store ? (
          <Card compact>
            <InfoRow icon="store" label="매장" value={store.name} />
            <InfoRow icon="pin" label="주소" value={store.address} />
            <InfoRow icon="clock" label="영업" value={store.hours} />
            <InfoRow
              icon="card"
              label="주문"
              value={store.open ? '지금 휴대폰 주문 가능' : '오늘 주문 마감'}
            />
            <InfoRow
              icon="clock"
              label="대기"
              value={store.wait ? `앞 주문 ${store.wait.ordersAhead}건 · 약 ${store.wait.minutes}분` : '매장에서 확인해 주세요'}
            />
          </Card>
      ) : (
        <T>매장을 다시 선택해 주세요.</T>
      );
      secondary = [
        {
          label: '다른 매장 찾기',
          run: discover,
        },
      ];
      break;
    case 'V5-04':
      body = subtitle(`${store?.name || '매장'} · 잠시만 기다려 주세요.`);
      primary = {
        label: '매장 다시 고르기',
        neutral: true,
        run: () => nav(s.found.length > 1 ? 'V5-02' : 'V5-02s'),
      };
      break;
    case 'V5-R1': {
      const last = s.history[s.storeId!];
      let current: Quote | undefined;
      if (last) {
        try {
          current = quote(store, s.products, fromOrder(last));
        } catch {
          /* The menu action below remains available. */
        }
      }
      body = last ? (
        <>
          {subtitle('이 매장에서 주문한 기록이 있어요.')}
          {sectionLabel('지난 주문')}
          <Card compact>
            {last.snapshot.items.map((line, i) => (
              <InfoRow
                key={i}
                icon="cup"
                label={line.name}
                value={`${line.labels.join(' · ')} · ${line.quantity}잔`}
              />
            ))}
            <InfoRow
              icon="card"
              label="현재 결제 금액"
              value={
                current ? money(current.total) : '메뉴를 다시 확인해 주세요.'
              }
            />
            {current && last.snapshot.total !== current.total && (
              <T kind="small">
                지난 결제 금액은 {money(last.snapshot.total)}이었어요.
              </T>
            )}
            <InfoRow
              icon="store"
              label="재고"
              value={
                current
                  ? '지금 모두 주문 가능'
                  : '지난 주문 그대로 주문할 수 없어요.'
              }
            />
          </Card>
        </>
      ) : null;
      primary = {
        label: current ? `${money(current.total)} 결제` : '지난 주문 결제',
        disabled: !current,
        run: () => checkout(true),
      };
      secondary = [{ label: '메뉴 직접 고르기', run: menu }];
      break;
    }
    case 'V5-M1':
    case 'V5-05': {
      primary = {
        label: s.cart.length
          ? `장바구니 보기 · ${cartQuote?.quantity || s.cart.length}개 · ${money(
              cartQuote?.total || 0,
            )}`
          : '장바구니 비어 있음',
        disabled: !s.cart.length,
        run: () => nav('V5-08'),
      };
      if (s.flow === 'V5-M1' && !s.query.trim()) {
        body = (
          <>
            {search('메뉴 이름 (예: 라떼)', '메뉴 이름으로 찾기')}
            {sectionLabel(`분류 · ${categories.length}개`)}
            {categories.slice(0, s.categoryLimit).map(c => (
              <NavigationRow
                key={c}
                icon="cup"
                title={c}
                description={`메뉴 ${
                  s.products.filter(p => p.category === c).length
                }개`}
                onPress={() => d({ type: 'CATEGORY', value: c })}
              />
            ))}
            {categories.length > s.categoryLimit && (
              <Button
                label="종류 6개 더 보기"
                onPress={() => d({ type: 'MORE_CATEGORIES' })}
              />
            )}
          </>
        );
        break;
      }
      const query = menuSearchKey(s.query);
      const groupedMenu = !query && categories.length <= 3 && s.products.length <= 20;
      const items = s.products
        .filter(p =>
          query
            ? menuSearchKey(p.name).includes(query)
            : groupedMenu || !s.category || p.category === s.category,
        )
        .sort(
          (a, b) => Number(Boolean(b.popular)) - Number(Boolean(a.popular)),
        );
      if (query) {
        searchStatus = items.length
          ? `메뉴 검색 결과 ${items.length}개`
          : '일치하는 메뉴가 없어요. 다른 이름으로 찾아 주세요.';
      }
      const last = s.history[s.storeId!];
      const recent = frequent(last, s.products);
      body = (
        <>
          {search('메뉴 이름 (예: 라떼)', '메뉴 이름으로 찾기')}
          {!query && recent.length > 0 && (
            <details className="frequent-menu" key={s.storeId}>
              <summary>자주 시킨 메뉴 {recent.length}개<span aria-hidden="true" /></summary>
              <div className="menu-items">
                {recent.map(p => {
                  const line = last?.snapshot.items.find(
                    i => i.productId === p.id,
                  );
                  return (
                    <NavigationRow
                      key={p.id}
                      photo
                      title={p.name}
                      description={
                        line
                          ? [...line.labels, '지난번 그대로'].join(' · ')
                          : undefined
                      }
                      price={line ? money(line.unitPrice) : undefined}
                      onPress={() =>
                        d({ type: 'SELECT_PRODUCT', id: p.id, recent: true })
                      }
                    />
                  );
                })}
              </div>
            </details>
          )}
          {!query && categories.length > 0 && <div className="section-divider" />}
          {!query &&
            categories.length > 0 &&
            (categories.length <= 3 ? (
              <div className="category-tabs" role="radiogroup" aria-label="메뉴 분류">
                {categories.map(c => {
                  const selected = c === (s.category || categories[0]);
                  return (
                    <View
                      key={c}
                      style={{
                        flex: 1,
                        minHeight: 48,
                        borderRadius: 999,
                        justifyContent: 'center',
                        backgroundColor: selected ? '#191919' : theme.card,
                        borderWidth: theme.contrast ? 2 : 0,
                        borderColor: theme.line,
                        padding: 8,
                      }}
                    >
                      <T
                        aria-hidden
                        style={{
                          textAlign: 'center',
                          fontWeight: '700',
                          fontSize: 19 * theme.scale,
                          color: selected ? '#FFFFFF' : theme.text,
                        }}
                      >
                        {c}
                      </T>
                      <ChoiceInput
                        name="menu-category"
                        label={c}
                        selected={selected}
                        onChange={() => {
                          d({ type: 'CATEGORY', value: c });
                          if (groupedMenu) document.getElementById(`menu-section-${categories.indexOf(c)}`)?.scrollIntoView({ block: 'start' });
                        }}
                      />
                    </View>
                  );
                })}
              </div>
            ) : (
              <Button label="메뉴 분류 선택" onPress={() => nav('V5-M1')} />
            ))}
          {(query ? ['검색 결과'] : groupedMenu || !s.category ? categories : [s.category]).map(group => {
            const groupItems = query ? items : items.filter(p => p.category === group);
            const visible = groupedMenu ? groupItems : groupItems.slice(0, s.menuLimit);
            if (!visible.length) return null;
            return (
              <section className="menu-group" key={group} id={`menu-section-${categories.indexOf(group)}`}>
                {sectionLabel(query ? group : `${group} · ${groupItems.length}개`)}
                <div className="menu-items">
                  {visible.map(p => (
                    <NavigationRow
                      key={p.id}
                      photo
                      title={p.name}
                      description={p.soldOut ? '오늘 준비 수량 소진' : p.description}
                      price={p.soldOut ? undefined : money(p.price)}
                      tag={p.soldOut ? '품절' : undefined}
                      label={p.soldOut ? `${p.name}, 품절, 오늘 준비 수량 소진` : undefined}
                      disabled={p.soldOut}
                      onPress={() => d({ type: 'SELECT_PRODUCT', id: p.id })}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {!items.length && (
            <T>일치하는 메뉴가 없어요. 다른 이름으로 찾아 주세요.</T>
          )}
          {!groupedMenu && items.length > s.menuLimit && (
            <Button
              label="메뉴 5개 더 듣기"
              onPress={() => {
                d({ type: 'MORE_MENU' });
                app.speak('다음 메뉴 5개를 보여드려요.');
              }}
            />
          )}
        </>
      );
      break;
    }
    case 'V5-05c':
      body = <>
        {productSummary}
        <AddedSheet
          summary={cartQuote?.items[cartQuote.items.length - 1]}
          total={cartQuote?.total}
          menu={menu}
          cart={() => nav('V5-08')}
        />
      </>;
      break;
    case 'V5-06':
    case 'V5-08e':
      body = (
        <>
          {productSummary}
          {product && options(product.options)}
          {quantity}
          <Card>
            <T kind="small">최종 금액</T>
            <T
              style={{
                fontSize: 36 * theme.scale,
                lineHeight: 50.4 * theme.scale,
                fontWeight: '700',
              }}
            >
              {money(selectedTotal)}
            </T>
            <T kind="small">
              1{unit}당 {money(selectedTotal / s.quantity)} · 총 {s.quantity}{unit}
              {product?.options.some(g => g.id === 'temperature') &&
              !s.selected.temperature
                ? ' · 온도를 먼저 골라 주세요'
                : ''}
            </T>
          </Card>
        </>
      );
      primary = {
        label: s.editId
          ? `변경 사항 저장 · ${money(selectedTotal)}`
          : `${money(selectedTotal)} 장바구니에 담기`,
        run: add,
      };
      break;
    case 'V5-06s':
      body = (
        <>
          {selectionSummary}
          {quantity}
          <T>기본 옵션 또는 지난 주문의 옵션이에요. 변경할 수 있어요.</T>
        </>
      );
      primary = { label: '이대로 담기', run: add };
      secondary = [
        { label: '옵션 바꾸기', run: () => d({ type: 'EDIT_OPTIONS' }) },
      ];
      break;
    case 'V5-M3':
      body = product && (
        <>
          <T kind="small">
            {product.name} · 옵션 {s.step + 1} / {product.options.length}
          </T>
          {options(product.options.slice(s.step, s.step + 1))}
        </>
      );
      primary = {
        label:
          s.returnReview || s.step === product!.options.length - 1
            ? '선택 내용 확인'
            : '다음 옵션',
        run: () => d({ type: 'STEP_NEXT' }),
      };
      secondary = [
        {
          label: '나머지는 기본값으로',
          run: () => d({ type: 'STEP_REST_DEFAULT' }),
        },
      ];
      break;
    case 'V5-M4':
      body = (
        <>
          {selectionSummary}
          {product?.options.map((g, index) => (
            <Button
              key={g.id}
              label={g.name + ' 바꾸기'}
              onPress={() => d({ type: 'EDIT_STEP', index })}
            />
          ))}
          {quantity}
        </>
      );
      primary = { label: '이대로 담기', run: add };
      break;
    case 'V5-08':
      body = (
        <>
          {store && (
            <Card compact>
              <InfoRow icon="store" label="주문 매장" value={store.name} />
              <InfoRow icon="bag" label="담은 메뉴" value={`${s.cart.length}종류 · 총 ${s.cart.reduce((n, line) => n + line.quantity, 0)}개`} />
            </Card>
          )}
          {!s.cart.length && (
            <Card>
              <T>아직 담은 메뉴가 없어요.</T>
            </Card>
          )}
          {s.cart.map((l, i) => (
            <Card key={l.id}>
              <View style={[st.row, { alignItems: 'flex-start' }]}>
                <View style={st.grow}>
                  <T kind="section">
                    {s.products.find(p => p.id === l.productId)?.name || '메뉴'}
                  </T>
                  <T kind="small">
                    {cartQuote?.items[i]?.labels.join(' · ') ||
                      '옵션 확인이 필요해요.'}
                  </T>
                </View>
                {cartQuote && (
                  <T style={{ fontSize: 20 * theme.scale, fontWeight: '700' }}>
                    {money(cartQuote.items[i].total)}
                  </T>
                )}
              </View>
              <Stepper
                compact
                quantity={l.quantity}
                unit={unitFor(s.products.find(p => p.id === l.productId)?.category)}
                onChange={value =>
                  d({
                    type: 'CART_QUANTITY',
                    id: l.id,
                    delta: value - l.quantity,
                  })
                }
              />
              <View style={st.row}>
                <View style={st.grow}>
                  <Button
                    appearance="compact"
                    label="옵션 변경"
                    onPress={() =>
                      d({
                        type: 'SELECT_PRODUCT',
                        id: l.productId,
                        lineId: l.id,
                      })
                    }
                  />
                </View>
                <View style={st.grow}>
                  <Button
                    appearance="compact"
                    label="삭제"
                    hint="이 메뉴를 장바구니에서 삭제"
                    onPress={() => d({ type: 'REMOVE', id: l.id })}
                  />
                </View>
              </View>
            </Card>
          ))}
          <Button label="+ 메뉴 더 담기" onPress={menu} />
          {cartQuote && (
            <>
              <div className="section-divider" />
              {sectionLabel('결제 정보')}
              <Card compact>
                <InfoRow
                  icon="card"
                  label="결제 금액"
                  value={money(cartQuote.total)}
                />
                <InfoRow
                  icon="card"
                  label="결제 수단"
                  value={
                    s.settings.mode === 'local'
                      ? '테스트 결제'
                      : '연결된 서버에서 확인'
                  }
                />
              </Card>
            </>
          )}
          {!!cartError && <T style={{ color: theme.danger }}>{cartError}</T>}
        </>
      );
      primary = {
        label: cartQuote ? `${money(cartQuote.total)} 결제` : '결제하기',
        run: () => checkout(),
        disabled: !cartQuote,
      };
      break;
    case 'V5-09':
      body = (
        <>
          {subtitle('주문 내용을 마지막으로 확인하고 있어요.')}
          <Card compact>
            <InfoRow
              icon="store"
              label="주문 매장"
              value={store?.name || '확인 중'}
            />
            <InfoRow icon="cup" label="품절 여부" value="확인 중" />
            <InfoRow
              icon="card"
              label="최종 금액"
              value={s.request ? money(s.request.expected.total) : '확인 중'}
            />
          </Card>
        </>
      );
      break;
    case 'PAYMENT_EXTERNAL': {
      const mock = !s.payment?.provider.startsWith('kakao');
      body = (
        <>
          <Card>
            <T kind="section">{mock ? '테스트 결제' : '카카오페이 결제'}</T>
            <T>
              {mock
                ? '실제로 돈이 청구되지 않아요. 아래 버튼으로 결제 결과를 체험해요.'
                : '새 탭에서 결제를 진행한 뒤 이 화면에서 결과를 확인해 주세요.'}
            </T>
            <T kind="section">{money(s.payment?.snapshot.total || 0)}</T>
          </Card>
          {mock && (
            <>
              <Button
                label="실패 상황 체험"
                disabled={app.busy}
                onPress={() => app.complete('fail')}
              />
              <Button
                label="시간 초과 체험"
                disabled={app.busy}
                onPress={() => app.complete('timeout')}
              />
            </>
          )}
        </>
      );
      primary = mock
        ? {
            label: app.busy ? '결제 처리 중' : '테스트 결제 완료',
            run: () => app.complete('success'),
            disabled: app.busy,
          }
        : { label: '결제 결과 확인', run: () => nav('P02-V') };
      secondary = [
        mock
          ? {
              label: '결제 취소',
              run: () => app.complete('cancel'),
              disabled: app.busy,
            }
          : {
              label: '결제 창 열기',
              run: () => {
                try {
                  if (!s.payment?.redirect) throw new Error('결제 창 주소가 없어요.');
                  Device.openPayment(s.payment.redirect, s.settings.serverUrl);
                } catch (e) {
                  alert('결제 창 확인', e instanceof Error ? e.message : '결제 창을 열 수 없어요.');
                }
              },
            },
      ];
      break;
    }
    case 'P01-E1':
      body = (
        <>
          {s.changed && <Receipt value={s.changed} />}
          <T>변경 내용을 확인한 뒤 장바구니에서 다시 결제해 주세요.</T>
        </>
      );
      primary = {
        label: '변경 내용 확인하고 장바구니로',
        run: () => d({ type: 'ACCEPT_CHANGED' }),
      };
      break;
    case 'P02-C':
    case 'P02-F':
      body = <Card compact>
        <InfoRow icon="card" label="결제 상태" value={s.flow === 'P02-C' ? '결제 취소' : '결제 실패'} />
        <T>담아 둔 메뉴는 장바구니에서 확인할 수 있어요.</T>
      </Card>;
      if (cartQuote && s.payment?.state === (s.flow === 'P02-C' ? 'cancelled' : 'failed')) {
        primary = { label: `다시 결제하기 · ${money(cartQuote.total)}`, run: () => d({ type: 'RETRY_CHECKOUT', key: key() }) };
      }
      secondary = [{ label: '장바구니로 돌아가기', run: () => d({ type: 'RETRY_PAYMENT' }) }];
      break;
    case 'P01-E2':
    case 'P02-T':
      body = (
        <Card>
          <T>담아 둔 메뉴는 그대로 있어요. 장바구니에서 다시 확인해 주세요.</T>
        </Card>
      );
      primary = {
        label: '장바구니로 돌아가기',
        run: () => d({ type: 'RETRY_PAYMENT' }),
      };
      break;
    case 'P02-V':
      body = (
        <>
          <Card>
            <T>{s.message || '서버에 결제 상태를 확인하고 있어요.'}</T>
            <T>
              결제 결과가 확인되지 않았다면 새로 결제하지 말고 결과를 다시
              확인해 주세요.
            </T>
          </Card>
          {s.payment && <Receipt value={s.payment.snapshot} />}
        </>
      );
      primary = { label: '결제 결과 다시 확인', run: () => nav('P02-V') };
      secondary =
        s.payment?.state === 'ready'
          ? [
              {
                label: '기존 결제 이어하기',
                run: () => nav('PAYMENT_EXTERNAL'),
              },
            ]
          : [];
      break;
    case 'V5-10':
      body = s.order && (
        <>
          {subtitle(
            s.order.demo
              ? '테스트 결제가 완료됐어요.'
              : '매장에 주문을 전달했어요.',
          )}
          <Card compact>
            <InfoRow icon="bag" label="주문번호" value={s.order.number} />
            <InfoRow
              icon="card"
              label="결제 금액"
              value={money(s.order.snapshot.total)}
            />
            <InfoRow
              icon="clock"
              label="준비 상태"
              value={
                s.order.demo
                  ? '데모 · 약 25초 후 준비 완료'
                  : '주문 현황에서 확인할 수 있어요.'
              }
            />
          </Card>
        </>
      );
      primary = {
        label: '주문 현황 보기',
        run: () => d({ type: 'OPEN_ORDER' }),
      };
      break;
    case 'V5-11':
      body = s.order && (
        <>
          {subtitle(`${s.order.snapshot.storeName} · 주문번호`)}
          <T
            style={{
              fontSize: 60 * theme.scale,
              lineHeight: 84 * theme.scale,
              fontWeight: '700',
            }}
          >
            {s.order.number}
          </T>
          <Card compact>
            {['주문 전달', '접수 완료', '준비 중', '픽업 가능'].map(
              (label, i) => {
                const active = i === (s.order?.status === 'received' ? 1 : 2);
                const done = i < (s.order?.status === 'received' ? 1 : 2);
                const phase = done ? '완료' : active ? '지금' : '대기';
                return (
                  <View
                    key={label}
                    accessible
                    accessibilityLabel={`${label}, ${phase}`}
                    style={[st.row, { minHeight: 42, paddingVertical: 4 }]}
                  >
                    <View
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 13,
                        borderWidth: 2,
                        borderColor: theme.text,
                        backgroundColor: active
                          ? '#FEE500'
                          : done
                          ? '#191919'
                          : theme.card,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {done && (
                        <T
                          style={{
                            color: '#FFFFFF',
                            fontSize: 15,
                            fontWeight: '700',
                          }}
                        >
                          ✓
                        </T>
                      )}
                    </View>
                    <T
                      style={{
                        flex: 1,
                        fontSize: 19 * theme.scale,
                        fontWeight: active ? '700' : '500',
                      }}
                    >
                      {label}
                    </T>
                    <T kind="small" style={{ fontWeight: '700' }}>
                      {phase}
                    </T>
                  </View>
                );
              },
            )}
          </Card>
          <Card compact>
            <InfoRow
              icon="cup"
              label="주문 상품"
              value={s.order.snapshot.items
                .map(x => [x.name, ...x.labels, `${x.quantity}${unitFor(s.products.find(p => p.id === x.productId)?.category)}`].join(' '))
                .join(' · ')}
            />
            <InfoRow
              icon="card"
              label="결제 금액"
              value={money(s.order.snapshot.total)}
            />
          </Card>
          {s.order.demo && <T kind="small">데모 주문의 준비 상태예요.</T>}
        </>
      );
      primary = {
        label: '주문 상태 다시 듣기',
        neutral: true,
        run: () =>
          app.speak(`${title}. 주문번호 ${s.order?.number || ''}.`),
      };
      break;
    case 'V5-12':
      body = s.order && (
        <>
          {subtitle('픽업대에서 주문번호를 보여주거나 말해 주세요.')}
          <View
            accessible
            accessibilityLabel={`주문번호 ${s.order.number}`}
            style={{
              backgroundColor: '#191919',
              borderRadius: 20,
              paddingHorizontal: 24,
              paddingVertical: 16,
            }}
          >
            <T kind="small" style={{ color: '#FFFFFF' }}>
              주문번호
            </T>
            <T
              style={{
                color: '#FFFFFF',
                fontSize: 60 * theme.scale,
                lineHeight: 84 * theme.scale,
                fontWeight: '700',
              }}
            >
              {s.order.number}
            </T>
          </View>
          <Card compact>
            <InfoRow
              icon="pin"
              label="픽업 장소"
              value={s.order.demo ? '데모 · 매장 픽업대' : '매장 픽업대'}
            />
          </Card>
        </>
      );
      primary = {
        label: '주문번호 다시 듣기',
        run: () => app.speak(`주문번호 ${s.order?.number || ''}`),
      };
      secondary = [
        {
          label: '픽업 완료',
          run: () => d({ type: 'PICKUP_COMPLETE' }),
        },
      ];
      break;
    case 'SETTINGS':
      body = (
        <SettingsPanel
          value={s.settings}
          change={value => d({ type: 'SETTINGS', value })}
          replay={() => d({ type: 'REPLAY_TRAINING' })}
          chooseDiscovery={() => nav('START')}
          canChooseDiscovery={!s.request && !s.payment}
        />
      );
      primary = { label: '설정 마치기', run: () => d({ type: 'BACK' }) };
      break;
  }
  const shortTitle = s.flow === 'V5-05' || s.flow === 'V5-06' ? title
    : s.flow === 'V5-08' ? '장바구니' : s.flow === 'V5-11' ? '주문 준비 중'
    : topLabels[s.flow]?.replace(/^\d \/ \d\s*/, '') || title;
  const cartScreen = ['V5-05', 'V5-M1'].includes(s.flow);
  const pinSecondary =
    height >= 650 &&
    fontScale * theme.scale < 1.5 &&
    ['START', 'BLE_GUIDE', 'V5-O1', 'V5-O4', 'V5-01e', 'V5-03', 'V5-R1', 'V5-06s', 'V5-12', 'P02-C', 'P02-F'].includes(s.flow);
  const hero =
    s.flow === 'START'
      ? 'store'
      : s.flow === 'V5-01'
      ? 'radar'
      : s.flow === 'V5-01e'
      ? 'alert'
      : s.flow === 'V5-04' || s.flow === 'V5-09'
      ? 'loading'
      : s.flow === 'V5-10' || s.flow === 'V5-12'
      ? 'check'
      : undefined;
  const screenMessage =
    s.flow === 'P02-V' || s.flow === 'V5-05c' ? '' : s.message;
  return (
    <ThemeContext.Provider value={theme}>
      <div className={`app-frame${entryScreen ? ' entry-frame' : ''}`} data-flow={s.flow} style={{ backgroundColor: theme.bg, color: theme.text, '--page': theme.bg, '--card': theme.card, '--divider': s.settings.dark ? theme.line : '#DCDDE2', '--muted': theme.muted, '--line': theme.line, '--scale': theme.scale } as React.CSSProperties}>
        <div className="visually-hidden" role="alert">
          {s.error !== 'CHANGE_STORE' ? s.error : ''}
        </div>
        <div className="visually-hidden" role="status">
          {searchStatus || screenMessage}
        </div>
        <View style={[st.header, { borderBottomWidth: 1.5, borderColor: titleScrolled ? (s.settings.dark ? theme.line : '#E1E2E6') : 'transparent' }]}>
          {!['BOOT', 'START', 'V5-O1'].includes(s.flow) && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="뒤로"
              onPress={() => d({ type: 'BACK' })}
              style={[
                st.chip,
                { flexDirection: 'row', alignItems: 'center', gap: 2 },
              ]}
            >
              <Icon name="back" size={30} color={theme.text} />
              <T style={{ fontSize: 20 * theme.scale, fontWeight: '700' }}>
                뒤로
              </T>
            </Pressable>
          )}
          <div className="compact-title" aria-hidden="true">{titleScrolled ? shortTitle : ''}</div>
          {s.flow !== 'SETTINGS' && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="설정"
              style={[st.chip, { alignItems: 'center' }]}
              onPress={() => nav('SETTINGS')}
            >
              <T kind="section"><span aria-hidden="true">⚙ </span>설정</T>
            </Pressable>
          )}
        </View>
        <div className="scroll-area">
          <div className="screen-scroll" ref={scroll}>
            <div className="screen-content" ref={content}>
              {hero && (
                <Icon
                  name={hero}
                  size={hero === 'radar' ? 120 : 64}
                  color={hero === 'loading' || hero === 'alert' ? theme.text : undefined}
                />
              )}
              {productHeading && <Photo large />}
              <Text
                ref={heading}
                accessibilityRole="header"
                accessible
                style={{
                  fontSize: 26 * theme.scale,
                  lineHeight: 36.4 * theme.scale,
                  includeFontPadding: false,
                  fontFamily,
                  fontWeight: '700',
                  color: theme.text,
                }}
              >
                {title}
              </Text>
              {!!s.error &&
                s.error !== 'CHANGE_STORE' &&
                !['E01', 'E02', 'E04', 'E05'].includes(s.flow) && (
                  <View>
                    <T
                      style={{ color: s.settings.dark ? '#FFADB3' : theme.danger }}
                    >
                      {s.error}
                    </T>
                  </View>
                )}
              {body}
              {/* On the menu, filter messages ("음료 메뉴 2개") are announced by the
                  status region; repeating them under the list read as an extra item. */}
              {!!screenMessage && s.flow !== 'V5-05' && <T>{screenMessage}</T>}
              {!pinSecondary &&
                secondary.map((b, i) => (
                  <Button
                    key={i}
                    label={b.label}
                    onPress={b.run}
                    disabled={b.disabled}
                  />
                ))}
            </div>
          </div>
          {hasMore && <div aria-hidden="true" className="more-hint"><span>아래에 더 있어요</span></div>}
        </div>
        {(primary || (pinSecondary && secondary.length > 0) || s.settings.staffHelp) && <div className="fixed-footer" data-testid="fixed-footer">
          {primary &&
            (cartScreen ? (
              <CartBar
                testID="primary-action"
                label={primary.label}
                quantity={s.cart.reduce((n, line) => n + line.quantity, 0)}
                total={
                  cartQuote
                    ? money(cartQuote.total)
                    : s.cart.length
                    ? '금액 확인 필요'
                    : '0원'
                }
                onPress={primary.run}
                disabled={!!primary.disabled}
              />
            ) : (
              <Button
                testID="primary-action"
                primary={!primary.neutral}
                label={primary.label}
                onPress={primary.run}
                disabled={primary.disabled}
              />
            ))}
          {pinSecondary &&
            secondary.map(b => (
              <Button
                key={b.label}
                label={b.label}
                onPress={b.run}
                disabled={b.disabled}
              />
            ))}
          {s.settings.staffHelp && <Button
            appearance="utility"
            label="직원 도움"
            icon={<Icon name="staff" size={24} color={theme.text} />}
            onPress={help}
          />}
        </div>}
        {dialog}
      </div>
    </ThemeContext.Provider>
  );
}
function AddedSheet({ summary, total, menu, cart }: {
  summary?: PricedLine; total?: number; menu: () => void; cart: () => void;
}) {
  const sheet = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const theme = useContext(ThemeContext);
  useEffect(() => {
    const el = sheet.current;
    el?.showModal();
    title.current?.focus();
    return () => el?.close();
  }, []);
  return (
    <dialog ref={sheet} className="added-sheet" aria-labelledby="added-title"
      style={{ background: theme.card, color: theme.text }}
      onCancel={event => { event.preventDefault(); menu(); }}>
      <div>
        <h2 id="added-title" ref={title} tabIndex={-1} className="section-heading">장바구니에 담았어요</h2>
        {summary && <InfoRow icon="bag" label="방금 담은 메뉴"
          value={[summary.name, ...summary.labels, `${summary.quantity}개`].join(' · ')} />}
        <Button primary label={total === undefined ? '장바구니로 이동' : `장바구니로 이동 · ${money(total)}`} onPress={cart} />
        <Button label="메뉴 더 고르기" onPress={menu} />
      </div>
    </dialog>
  );
}
function Receipt({ value }: { value: Quote }) {
  return (
    <Card>
      <T kind="section">주문 내용</T>
      {value.items.map((l, i) => (
        <View key={i} style={{ gap: 6 }}>
          <T>
            {l.name} {l.quantity}개
          </T>
          <T kind="small">{l.labels.join(', ')}</T>
          <T>{money(l.total)}</T>
        </View>
      ))}
      <T kind="section">합계 {money(value.total)}</T>
    </Card>
  );
}
function SettingsPanel({
  value,
  change,
  replay,
  chooseDiscovery,
  canChooseDiscovery,
}: {
  value: Settings;
  change: (v: Partial<Settings>) => void;
  replay: () => void;
  chooseDiscovery: () => void;
  canChooseDiscovery: boolean;
}) {
  const toggles = [
    ['large', '큰 글씨', '글자를 더 크게'],
    ['contrast', '고대비', '글자와 배경 대비를 더 강하게'],
    ['dark', '어두운 화면', '검은 바탕에 밝은 글자'],
    ['quickOptions', '기본 옵션 빠르게 담기', '옵션 화면 없이 기본값으로 담기'],
    ['staffHelp', '직원에게 보여주기', '켜면 화면 아래에 ‘직원 도움’ 버튼이 표시돼요'],
  ] as const;
  return (
    <>
      {toggles.map(([k, label, detail]) => (
        <button type="button" key={k} className="setting-row" role="switch" aria-label={label}
          aria-checked={value[k]} aria-describedby={`setting-${k}`} onClick={() => change({ [k]: !value[k] })}>
          <span className="setting-copy"><strong>{label}</strong><span id={`setting-${k}`}>{detail}</span></span>
          <span className="switch-state" aria-hidden="true">
            {value[k] ? '켬' : '끔'}<span className="switch-track" />
          </span>
        </button>
      ))}
      <Button label="사용법 다시 듣기" onPress={replay} />
      <Button label="매장 찾기 방식 선택" onPress={chooseDiscovery} disabled={!canChooseDiscovery} />
    </>
  );
}
