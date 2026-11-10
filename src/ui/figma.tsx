import React, { useContext } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
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
      accessible={false}
      style={[
        styles.photo,
        { backgroundColor: theme.card },
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
      accessible
      accessibilityLabel={`${label}, ${value}`}
      style={styles.infoRow}
    >
      <Icon name={icon} color={theme.text} />
      <View style={styles.copy}>
        <T kind="small">{label}</T>
        <T
          style={{
            fontSize: 20 * theme.scale,
            lineHeight: 27 * theme.scale,
            fontWeight: '500',
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
  nativeClick = false,
}: {
  title: string;
  description?: string;
  price?: string;
  icon?: IconName;
  photo?: boolean;
  tag?: string;
  onPress: () => void;
  disabled?: boolean;
  nativeClick?: boolean;
}) {
  const theme = useContext(ThemeContext);
  if (nativeClick) {
    return (
      <View style={[styles.navRow, { position: 'relative', backgroundColor: theme.card, borderWidth: theme.contrast ? 2 : 0, borderColor: theme.line, opacity: disabled ? 0.45 : 1 }]}>
        <View aria-hidden style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 }}>
          {icon && <Icon name={icon} color={theme.text} />}
          <View style={styles.copy}>
            <T style={{ fontSize: 20 * theme.scale, lineHeight: 27 * theme.scale, fontWeight: '500' }}>{title}</T>
            {!!description && <T kind="small">{description}</T>}
          </View>
          <Icon name="next" size={26} color={theme.text} />
        </View>
        <button
          type="button"
          className="browser-action"
          aria-label={[title, description].filter(Boolean).join(', ')}
          disabled={disabled}
          onClick={onPress}
          style={{ position: 'absolute', inset: 0, width: '100%', border: 0, borderRadius: 16, background: 'transparent', cursor: disabled ? 'default' : 'pointer' }}
        />
      </View>
    );
  }
  return (
    <Pressable
      accessible
      accessibilityRole={disabled ? 'text' : 'button'}
      accessibilityLabel={[title, description, price, tag]
        .filter(Boolean)
        .join(', ')}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.navRow,
        photo && styles.menuRow,
        {
          backgroundColor: theme.card,
          borderWidth: theme.contrast ? 2 : 0,
          borderColor: theme.line,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {photo ? <Photo /> : icon && <Icon name={icon} color={theme.text} />}
      <View style={styles.copy}>
        <T
          style={{
            fontSize: 20 * theme.scale,
            lineHeight: 27 * theme.scale,
            fontWeight: '500',
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
    </Pressable>
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
            lineHeight: 28 * theme.scale,
            fontWeight: '500',
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
}: {
  quantity: number;
  onChange: (value: number) => void;
  compact?: boolean;
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
                {quantity}잔
              </T>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                delta < 0 ? '수량 한 개 줄이기' : '수량 한 개 늘리기'
              }
              aria-disabled={disabled}
              disabled={disabled}
              onPress={() => onChange(quantity + delta)}
              style={({ pressed }) => ({
                minWidth: size,
                minHeight: size,
                borderRadius: 12,
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: delta === 1 ? '#191919' : theme.bg,
                borderWidth: theme.contrast ? 2 : 0,
                borderColor: theme.line,
                opacity: disabled ? 0.55 : pressed ? 0.7 : 1,
              })}
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
            </Pressable>
          </React.Fragment>
        );
      })}
    </View>
  );
}

export function CartBar({
  label,
  quantity,
  total,
  onPress,
  testID,
  disabled,
}: {
  label: string;
  quantity: number;
  total: string;
  onPress: () => void;
  testID?: string;
  disabled: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.cart, { opacity: pressed ? 0.8 : 1 }]}
    >
      <Icon name="bag" color="#FFFFFF" />
      <View style={styles.copy}>
        <T style={styles.cartText}>
          {quantity ? `장바구니 ${quantity}잔` : '장바구니 비어 있음'}
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1, gap: 2 },
  photo: {
    width: 72,
    height: 72,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  largePhoto: { width: '100%', height: 190, gap: 6 },
  infoRow: {
    minHeight: 69,
    flexDirection: 'row',
    alignItems: 'center',
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
  menuRow: { minHeight: 103, paddingLeft: 14, paddingRight: 10 },
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
  cart: {
    minHeight: 70,
    backgroundColor: '#191919',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  cartText: { color: '#FFFFFF', fontWeight: '500', fontSize: 15 },
  cartGo: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 9,
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
  },
});
