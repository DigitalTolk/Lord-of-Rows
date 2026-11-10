import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

// Add languages by dropping in another JSON file with the same keys.
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React escapes output already
});

export default i18n;
