import { cachedThemePref, nextThemePref, parseThemePref, THEME_SETTING, type ThemePref } from '../lib/theme';
import { useApp } from '../store';
import { Icon, type IconName } from './icons';

const META: Record<ThemePref, { icon: IconName; label: string }> = {
  system: { icon: 'monitor', label: 'System' },
  light: { icon: 'sun', label: 'Light' },
  dark: { icon: 'moon', label: 'Dark' },
  hc: { icon: 'contrast', label: 'High contrast' },
};

/** One-click appearance toggle: System -> Light -> Dark (high contrast lives in Settings). */
export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const pref = parseThemePref(useApp((s) => s.settings[THEME_SETTING]) ?? cachedThemePref());
  const next = nextThemePref(pref);
  const title = `Appearance: ${META[pref].label} (click for ${META[next].label})`;
  return (
    <button className={className} title={title} aria-label={title} onClick={() => useApp.getState().setSetting(THEME_SETTING, next).catch((e) => useApp.getState().toast('error', `Could not save theme: ${e?.message ?? e}`))}>
      <Icon name={META[pref].icon} />
    </button>
  );
}
