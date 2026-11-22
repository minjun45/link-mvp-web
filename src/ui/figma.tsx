import React, { useContext } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { T, ThemeContext } from './kit';

import radar from './assets/radar.png';
import loading from './assets/loading.png';
import check from './assets/check.png';
import photo from './assets/photo.png';
import menuPhoto from './assets/menuPhoto.png';
import search from './assets/search.png';
import mic from './assets/mic.png';
import back from './assets/back.png';
import next from './assets/next.png';
import speaker from './assets/speaker.png';
import staff from './assets/staff.png';
import bag from './assets/bag.png';
import clock from './assets/clock.png';
import store from './assets/store.png';
import pin from './assets/pin.png';
import card from './assets/card.png';
import cup from './assets/cup.png';
import alert from './assets/alert.svg';

const artwork = {
  alert,
  radar,
  loading,
  check,
  photo,
  menuPhoto,
  search,
  mic,
  back,
  next,
  speaker,
  staff,
  bag,
  clock,
  store,
  pin,
  card,
  cup,
};

export type IconName = keyof typeof artwork;

export function Icon({
  name,
  size = 28,
  color,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return (
    <Image
      aria-hidden
      accessible={false}
      source={{ uri: artwork[name] }}
      resizeMode="contain"
      style={{ width: size, height: size, tintColor: color }}
    />
  );
}

export function Photo({ large = false }: { large?: boolean }) {
  const theme = useContext(ThemeContext);
  return (
    <View
      aria-hidden
      accessible={false}
      style={[
        styles.photo,
        { backgroundColor: theme.bg === '#F2F3F5' ? '#E1E2E6' : theme.bg },
        large && styles.largePhoto,
      ]}
    >
      <Icon
        name={large ? 'photo' : 'menuPhoto'}
        size={large ? 48 : 30}
        color={theme.muted}
      />
      {large && <T kind="small">메뉴 사진</T>}
    </View>
  );
}

export function InfoRow({
  icon,
  label,
  value,
}: {
  icon: IconName;
  label: string;
  value: string;
}) {
  const theme = useContext(ThemeContext);
  return (
    <View
      style={styles.infoRow}
    >
      <Icon name={icon} color={theme.text} />
      <View style={styles.copy}>
        <T kind="small" style={{ fontSize: 15 * theme.scale, lineHeight: 21 * theme.scale, fontWeight: '500' }}>{label}</T>
        <T
          style={{
            fontSize: 20 * theme.scale,
            lineHeight: 29.4 * theme.scale,
            fontWeight: '700',
          }}
        >
          {value}
        </T>
      </View>
    </View>
  );
}

export function NavigationRow({
  title,
  description,
  price,
  icon,
  photo,
  tag,
  onPress,
  disabled,
}: {
  title: string;
  description?: string;
  price?: string;
  icon?: IconName;
  photo?: boolean;
  tag?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useContext(ThemeContext);
  return (
    <button
      type="button"
      className={photo ? 'app-button nav-button menu-button' : 'app-button nav-button'}
      disabled={disabled}
      onClick={onPress}
      style={{
        backgroundColor: theme.card,
        borderWidth: theme.contrast ? 2 : 0,
        borderColor: theme.line,
      }}
    >
      {photo ? <Photo /> : icon && <Icon name={icon} color={theme.text} />}
      <View style={styles.copy}>
        <T
          style={{
            fontSize: 21 * theme.scale,
            lineHeight: 29.4 * theme.scale,
            fontWeight: '700',
          }}
        >
          {title}
        </T>
        {!!description && <T kind="small">{description}</T>}
        {!!price && (
          <T
            style={{
              fontSize: 19 * theme.scale,
              lineHeight: 26 * theme.scale,
              fontWeight: '700',
            }}
          >
            {price}
          </T>
        )}
      </View>
      {tag ? (
        <T style={styles.tag}>{tag}</T>
      ) : (
        <Icon name="next" size={26} color={theme.text} />
      )}
    </button>
  );
}

export function ChoiceInput({
  name,
  label,
  selected,
  onChange,
}: {
  name: string;
  label: string;
  selected: boolean;
  onChange: () => void;
}) {
  return (
    <input
      className="choice-input"
      type="radio"
      name={name}
      aria-label={label}
      checked={selected}
      onChange={onChange}
    />
  );
}

export function OptionRow({
  name,
  label,
  detail,
  selected,
  onPress,
}: {
  name: string;
  label: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useContext(ThemeContext);
  return (
    <View
      style={[
        styles.navRow,
        {
          backgroundColor: selected ? theme.selected : theme.card,
          borderColor: selected ? theme.text : theme.line,
          borderWidth: selected || theme.contrast ? 2 : 0,
        },
      ]}
    >
      <View
        aria-hidden
        style={[
          styles.radio,
          { borderColor: selected ? theme.text : theme.line },
        ]}
      >
        {selected && (
          <View style={[styles.dot, { backgroundColor: theme.text }]} />
        )}
      </View>
      <View aria-hidden style={styles.copy}>
        <T
          style={{
            fontSize: 21 * theme.scale,
            lineHeight: 29.4 * theme.scale,
            fontWeight: '700',
          }}
        >
          {label}
        </T>
        {(!!detail || selected) && (
          <T kind="small">
            {[detail, selected && '선택됨'].filter(Boolean).join(' · ')}
          </T>
        )}
      </View>
      <ChoiceInput
        name={name}
        label={[label, detail].filter(Boolean).join(', ')}
        selected={selected}
        onChange={onPress}
      />
    </View>
  );
}

export function Stepper({
  quantity,
  onChange,
  compact = false,
  unit = '개',
}: {
  quantity: number;
  onChange: (value: number) => void;
  compact?: boolean;
  unit?: string;
}) {
  const theme = useContext(ThemeContext);
  const size = compact ? 56 : 68;
  return (
    <View
      style={[
        styles.stepper,
        !compact && {
          backgroundColor: theme.card,
          padding: 10,
          borderWidth: theme.contrast ? 2 : 0,
          borderColor: theme.line,
        },
      ]}
    >
      {([-1, 1] as const).map(delta => {
        const disabled = delta === -1 ? quantity <= 1 : quantity >= 20;
        return (
          <React.Fragment key={delta}>
            {delta === 1 && (
              <T
                style={{
                  fontSize: (compact ? 20 : 30) * theme.scale,
                  lineHeight: (compact ? 28 : 40) * theme.scale,
                  fontWeight: '700',
                  textAlign: 'center',
                  flex: 1,
                }}
              >
                <span aria-live="polite" aria-atomic="true">{quantity}{unit}</span>
              </T>
            )}
            <button
              type="button"
              className="app-button stepper-button"
              aria-label={
                delta < 0 ? '수량 한 개 줄이기' : '수량 한 개 늘리기'
              }
              disabled={disabled}
              onClick={() => onChange(quantity + delta)}
              style={{
                minWidth: size,
                minHeight: size,
                borderRadius: 12,
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: delta === 1 ? '#191919' : theme.bg,
                borderWidth: theme.contrast ? 2 : 0,
                borderColor: theme.line,
              }}
            >
              <T
                style={{
                  color: delta === 1 ? '#FFFFFF' : theme.text,
                  fontSize: 32,
                  lineHeight: 36,
                  fontWeight: '700',
                }}
              >
                {delta === 1 ? '+' : '−'}
              </T>
            </button>
          </React.Fragment>
        );
      })}
    </View>
  );
}

export function CartBar({
  quantity,
  total,
  onPress,
  testID,
  disabled,
}: {
  quantity: number;
  total: string;
  onPress: () => void;
  testID?: string;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      className="app-button cart-button"
      data-testid={testID}
      disabled={disabled}
      onClick={onPress}
    >
      <Icon name="bag" color="#FFFFFF" />
      <View style={styles.copy}>
        <T style={styles.cartText}>
          {quantity ? `장바구니 ${quantity}개` : '장바구니 비어 있음'}
        </T>
        <T kind="section" style={{ color: '#FFFFFF' }}>
          {total}
        </T>
      </View>
      <View
        style={[
          styles.cartGo,
          { backgroundColor: disabled ? '#E4E5E9' : '#FEE500' },
        ]}
      >
        <T style={{ color: '#191919', fontWeight: '700' }}>보기</T>
        <Icon name="next" size={18} color="#191919" />
      </View>
    </button>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1, gap: 2 },
  photo: {
    width: 72,
    height: 72,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  largePhoto: { width: '100%', height: 190, gap: 6 },
  infoRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 8,
  },
  navRow: {
    minHeight: 87,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  tag: {
    color: '#FFFFFF',
    backgroundColor: '#191919',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontWeight: '700',
  },
  radio: {
    width: 28,
    height: 28,
    borderWidth: 2,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 14, height: 14, borderRadius: 7 },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    gap: 12,
  },
  cartText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  cartGo: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 9,
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
  },
});
