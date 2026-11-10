import React, { createContext, useContext } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
export const fontFamily = 'LinkNoto, sans-serif';
export type Theme = {
  bg: string;
  card: string;
  text: string;
  muted: string;
  line: string;
  selected: string;
  danger: string;
  scale: number;
  contrast: boolean;
};
export const light: Theme = {
  bg: '#F2F3F5',
  card: '#FFFFFF',
  text: '#191919',
  muted: '#555555',
  line: '#767676',
  selected: '#FFF7CC',
  danger: '#A91D26',
  scale: 1,
  contrast: false,
};
export const ThemeContext = createContext(light);
export function T({
  children,
  kind = 'body',
  ...props
}: {
  children: React.ReactNode;
  kind?: 'title' | 'section' | 'body' | 'small';
} & React.ComponentProps<typeof Text>) {
  const t = useContext(ThemeContext);
  const sizes = { title: 26, section: 21, body: 17, small: 16 };
  return (
    <Text
      {...props}
      style={[
        {
          color: kind === 'small' ? t.muted : t.text,
          fontSize: sizes[kind] * t.scale,
          lineHeight: Math.round(sizes[kind] * t.scale * 1.35),
          fontWeight: kind === 'title' || kind === 'section' ? '700' : '400',
          flexShrink: 1,
          includeFontPadding: false,
          fontFamily,
        },
        props.style,
      ]}
    >
      {children}
    </Text>
  );
}
export function Card({
  children,
  compact = false,
}: {
  children: React.ReactNode;
  compact?: boolean;
}) {
  const t = useContext(ThemeContext);
  return (
    <View
      style={{
        backgroundColor: t.card,
        borderRadius: 20,
        paddingHorizontal: 24,
        paddingVertical: compact ? 10 : 16,
        gap: compact ? 2 : 12,
        borderWidth: t.contrast ? 2 : 0,
        borderColor: t.line,
      }}
    >
      {children}
    </View>
  );
}
export function Button({
  label,
  onPress,
  primary = false,
  selected,
  disabled = false,
  hint,
  testID,
  appearance = 'standard',
  icon,
  nativeClick = false,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  selected?: boolean;
  disabled?: boolean;
  hint?: string;
  testID?: string;
  appearance?: 'standard' | 'utility' | 'compact' | 'dark';
  icon?: React.ReactNode;
  nativeClick?: boolean;
}) {
  const t = useContext(ThemeContext);
  const utility = appearance === 'utility';
  const compact = appearance === 'compact' || appearance === 'dark';
  const dark = appearance === 'dark';
  if (nativeClick) {
    // Permission-gated browser APIs must run directly in the trusted DOM click.
    // Opt in only for these actions, preserving the other controls' behavior.
    return (
      <button
        type="button"
        className="browser-action"
        data-testid={testID}
        aria-label={label}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={onPress}
        style={{
          display: 'flex',
          width: '100%',
          boxSizing: 'border-box',
          minHeight: utility ? 60 : compact ? 56 : 72,
          padding: `${compact || utility ? 10 : 14}px ${compact || utility ? 8 : 16}px`,
          borderRadius: 12,
          justifyContent: 'center',
          alignItems: 'center',
          gap: 8,
          border: t.contrast && !primary ? `2px solid ${t.line}` : '0',
          backgroundColor: primary ? '#FEE500' : utility ? t.card : t.bg === light.bg ? '#E4E5E9' : t.card,
          color: primary ? '#000000' : t.text,
          fontFamily,
          fontSize: (utility ? 18 : compact ? 17 : 21) * t.scale,
          lineHeight: `${(utility ? 24 : compact ? 23 : 28) * t.scale}px`,
          fontWeight: utility ? '500' : '700',
          textAlign: 'center',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
        }}
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole={selected === undefined ? 'button' : 'radio'}
      accessibilityLabel={label}
      accessibilityHint={hint}
      aria-disabled={disabled}
      aria-checked={selected}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: utility ? 60 : compact ? 56 : 72,
        paddingVertical: compact || utility ? 10 : 14,
        paddingHorizontal: compact || utility ? 8 : 16,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
        backgroundColor: primary
          ? '#FEE500'
          : selected
          ? t.selected
          : dark
          ? '#191919'
          : utility
          ? t.card
          : t.bg === light.bg
          ? '#E4E5E9'
          : t.card,
        borderWidth: selected || (t.contrast && !primary) ? 2 : 0,
        borderColor: selected ? t.text : t.line,
        opacity: disabled ? 0.45 : pressed ? 0.65 : 1,
      })}
    >
      {icon}
      <T
        style={{
          textAlign: 'center',
          color: primary ? '#000000' : dark ? '#FFFFFF' : t.text,
          fontSize: (utility ? 18 : compact ? 17 : 21) * t.scale,
          lineHeight: (utility ? 24 : compact ? 23 : 28) * t.scale,
          fontWeight: utility ? '500' : '700',
        }}
      >
        {selected ? '✓ ' : ''}
        {label}
      </T>
    </Pressable>
  );
}
export const styles = StyleSheet.create({
  stack: { gap: 16 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  grow: { flex: 1 },
  input: {
    minHeight: 64,
    borderWidth: 2,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 17,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 10,
  },
  header: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  chip: {
    paddingHorizontal: 6,
    paddingVertical: 8,
    minHeight: 48,
    minWidth: 48,
    justifyContent: 'center',
  },
});
