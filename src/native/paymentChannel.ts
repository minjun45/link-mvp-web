type BrowserProfile = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
};

export function paymentChannel(browser?: BrowserProfile): 'mobile' | 'pc' {
  if (browser?.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(browser?.userAgent ?? ''))
    return 'mobile';
  // iPadOS desktop mode presents the Mac platform and a desktop Safari user agent.
  if (browser?.platform === 'MacIntel' && (browser.maxTouchPoints ?? 0) > 1) return 'mobile';
  return 'pc';
}
