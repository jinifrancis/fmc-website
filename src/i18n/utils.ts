import { ui, defaultLang, type Lang } from './ui';

type TranslationKey = keyof typeof ui[typeof defaultLang];

export function getLangFromUrl(url: URL): Lang {
  const [, lang] = url.pathname.split('/');
  if (lang in ui) return lang as Lang;
  return defaultLang;
}

export function useTranslations(lang: string) {
  return function t(key: string): string {
    const l = lang as Lang;
    return (ui[l]?.[key as TranslationKey] || ui[defaultLang][key as TranslationKey]) ?? key;
  }
}

export function useTranslatedPath(lang: string) {
  return function translatePath(path: string, l: string = lang): string {
    return l === defaultLang ? path : `/${l}${path}`;
  }
}
