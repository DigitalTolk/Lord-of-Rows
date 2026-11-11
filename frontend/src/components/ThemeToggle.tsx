import { useTranslation } from 'react-i18next';
import { cachedThemePref, nextThemePref, parseThemePref, THEME_SETTING, type ThemePref } from '../lib/theme';
import { useApp } from '../store';
import { Icon, type IconName } from './icons';

const META: Record<ThemePref, { icon: IconName; label: string }> = {
  system: { icon: 'monitor', label: 'settings.themeSystem' },
  light: { icon: 'sun', label: 'settings.themeLight' },
  dark: { icon: 'moon', label: 'settings.themeDark' },
  hc: { icon: 'contrast', label: 'settings.themeHc' },
};

/** One-click appearance toggle: System -> Light -> Dark (high contrast lives in Settings). */
export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const { t } = useTranslation();
  const pref = parseThemePref(useApp((s) => s.settings[THEME_SETTING]) ?? cachedThemePref());
  const next = nextThemePref(pref);
  const title = t('theme.toggle', { current: t(META[pref].label), next: t(META[next].label) });
  return (
    <button className={className} title={title} aria-label={title} onClick={() => useApp.getState().setSetting(THEME_SETTING, next).catch((e) => useApp.getState().toast('error', t('theme.saveFailed', { error: e?.message ?? String(e) })))}>
      <Icon name={META[pref].icon} />
    </button>
  );
}
