import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import en from '../locales/en.json'
import zhCN from '../locales/zh-CN.json'

export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_STORAGE_KEY = 'dsh-cloud.locale'

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

function syncDocumentLanguage(lng: string): void {
  document.documentElement.lang = lng
  document.title = i18n.t('app.title')
}

// 必须在 init 之前挂：i18next 在 init 内部就会发出第一次 languageChanged
i18n.on('languageChanged', syncDocumentLanguage)

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
    },
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LOCALES],
    // 不写这句 i18next 会把 zh-CN 归一成 zh，就匹配不到上面的资源了
    load: 'currentOnly',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
    },
  })

export default i18n
