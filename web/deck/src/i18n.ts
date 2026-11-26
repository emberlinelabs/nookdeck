import { VI } from './i18n-vi'
import { ZH } from './i18n-zh'
import { FR } from './i18n-fr'
import { PT } from './i18n-pt'

/**
 * Tiny dictionary i18n. English is the default; Vietnamese, Chinese, French and Brazilian Portuguese come from
 * layout.theme.language ('en' | 'vi' | 'zh' | 'fr' | 'pt', missing = 'en').
 * The English text is the key: t('Cancel') returns the translated entry when that language is on and the
 * text itself otherwise.
 * Placeholders are {0}, {1}...: t('{0} min ago', 5). Module level constants must hold English text and be passed through t() at use time.
 */

export type Lang = 'en' | 'vi' | 'zh' | 'fr' | 'pt'
const KEY = 'pd.lang'
const DICTS: { [lang: string]: { [en: string]: string } } = { vi: VI, zh: ZH, fr: FR, pt: PT }
const LANGS: Lang[] = ['en', 'vi', 'zh', 'fr', 'pt']
const isLang = (v: unknown): v is Lang => LANGS.indexOf(v as Lang) >= 0
/** First two letters of a device language (fr-CA, pt-PT and pt-BR all count); English otherwise. */
export function fromDevice(tag: string): Lang {
  const p = (tag || '').toLowerCase().slice(0, 2)
  return isLang(p) ? p : 'en'
}

/** Used until a layout arrives (the pairing screen) and whenever a layout carries no language: the device's own language. */
const FALLBACK: Lang = (() => {
  try {
    return fromDevice(window.navigator.language || '')
  } catch (e) {
    return 'en'
  }
})()

let cur: Lang = 'en'
try {
  const s = window.localStorage.getItem(KEY)
  cur = isLang(s) ? s : FALLBACK
} catch (e) {
  /* storage is optional */
}

export const getLang = (): Lang => cur

/** Called by the deck whenever the layout (or its theme) changes; remembered so the pairing screen uses the same language. */
export function setLang(l: unknown) {
  const next: Lang = isLang(l) ? l : FALLBACK
  if (next === cur) return
  cur = next
  try {
    window.localStorage.setItem(KEY, next)
  } catch (e) {
    /* ignore */
  }
}

export function t(en: string, a?: string | number, b?: string | number, c?: string | number): string {
  const dict = DICTS[cur]
  let s = dict && Object.prototype.hasOwnProperty.call(dict, en) ? dict[en] : en
  const args = [a, b, c]
  for (let i = 0; i < 3; i++) {
    if (args[i] !== undefined) s = s.split('{' + i + '}').join(String(args[i]))
  }
  return s
}

/** BCP 47 tag for Intl and toLocaleString. */
export const locale = (): string => (cur === 'vi' ? 'vi-VN' : cur === 'zh' ? 'zh-CN' : cur === 'fr' ? 'fr-FR' : cur === 'pt' ? 'pt-BR' : 'en-US')
