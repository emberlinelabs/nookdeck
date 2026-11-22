import { en, type Dict } from './en';
import { vi } from './vi';
import { zh } from './zh';
export type Lang = 'en' | 'vi' | 'zh';
export const dicts: Record<Lang, Dict> = { en, vi, zh };
export const paths: Record<Lang, string> = { en: '/', vi: '/vi/', zh: '/zh/' };
export const GITHUB = 'https://github.com/howznguyen/nookdeck';
export const RAW = 'https://raw.githubusercontent.com/howznguyen/nookdeck/main';
export const SITE = 'https://nookdeck.app';
