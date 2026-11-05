import type { Incident } from '../types';

/**
 * Небольшой справочник населённых пунктов для «Избранного».
 *
 * Это НЕ геокодинг и не база всех городов страны — только ручной список
 * заметных точек плюс то, что уже встречается в отчётах. Честно: если нужного
 * места нет в списке, его можно добавить вручную (кнопка «Добавить своё место»)
 * — координаты тогда берутся из отчётов или не заполняются вовсе, а не
 * выдумываются.
 */

export interface Place {
  /** Уникальный ключ: имя + регион в нормализованном виде */
  id: string;
  name: string;
  region: string;
  /** Широта / долгота — только для точек, где координаты реально известны */
  lat?: number;
  lon?: number;
}

const PLACE_SEED: Array<Omit<Place, 'id'>> = [
  { name: 'Жижица', region: 'Псковская область', lat: 56.0514, lon: 31.2 },
  { name: 'Кунья', region: 'Псковская область', lat: 56.2892, lon: 30.9725 },
  { name: 'Великие Луки', region: 'Псковская область', lat: 56.3328, lon: 30.5458 },
  { name: 'Псков', region: 'Псковская область', lat: 57.8194, lon: 28.3318 },
  { name: 'Москва', region: 'Москва и МО', lat: 55.7558, lon: 37.6173 },
  { name: 'Санкт-Петербург', region: 'Санкт-Петербург', lat: 59.9343, lon: 30.3351 },
  { name: 'Краснодар', region: 'Краснодарский край', lat: 45.0355, lon: 38.9753 },
  { name: 'Ростов-на-Дону', region: 'Ростовская область', lat: 47.2357, lon: 39.7015 },
  { name: 'Махачкала', region: 'Республика Дагестан', lat: 42.9849, lon: 47.5047 },
  { name: 'Казань', region: 'Республика Татарстан', lat: 55.7963, lon: 49.1088 },
  { name: 'Екатеринбург', region: 'Свердловская область', lat: 56.8389, lon: 60.6057 },
  { name: 'Новосибирск', region: 'Новосибирская область', lat: 55.0084, lon: 82.9357 },
  { name: 'Владивосток', region: 'Приморский край', lat: 43.1155, lon: 131.8855 },
  { name: 'Симферополь', region: 'Республика Крым', lat: 44.9521, lon: 34.1024 },
  { name: 'Белгород', region: 'Белгородская область', lat: 50.5952, lon: 36.5873 },
  { name: 'Курск', region: 'Курская область', lat: 51.7304, lon: 36.1926 },
  { name: 'Брянск', region: 'Брянская область', lat: 53.2435, lon: 34.3634 },
  { name: 'Смоленск', region: 'Смоленская область', lat: 54.7818, lon: 32.0401 },
];

export const normPlace = (s: string): string =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const norm = normPlace;

/** Ключ места — по имени и региону, без выдуманных координат. */
export const placeKey = (name: string, region: string): string =>
  `${norm(name)}|${norm(region)}`;

export const PLACES: Place[] = PLACE_SEED.map((p) => ({
  ...p,
  id: placeKey(p.name, p.region),
}));

/** Поиск по названию и региону: «жижица», «кунья», «псков» — всё находится. */
export function searchPlaces(query: string, limit = 8): Place[] {
  const q = norm(query);
  if (!q) return PLACES.slice(0, limit);
  const words = q.split(' ');
  const scored = PLACES.map((p) => {
    const hay = norm(`${p.name} ${p.region}`);
    let score = 0;
    for (const w of words) {
      if (!w) continue;
      if (norm(p.name) === q) score += 40;
      if (norm(p.name).startsWith(w)) score += 14;
      else if (norm(p.name).includes(w)) score += 8;
      if (hay.includes(w)) score += 3;
    }
    return { p, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.p);
}

/** Избранные места храним в localStorage — без аккаунта и без сервера. */
const KEY = 'pulsenet_favorite_places';

export function loadFavorites(): Place[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Place[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string');
  } catch {
    return [];
  }
}

export function saveFavorites(list: Place[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 12)));
  } catch {
    /* приватный режим — просто не запоминаем */
  }
}

/** Чем это место известно в отчётах: сколько сбоев и когда последний. */
export function placeSummary(
  place: Place,
  incidents: Incident[]
): { total: number; active: number; lastAt: string | null } {
  const key = norm(place.name);
  const regionKey = norm(place.region);
  const related = incidents.filter((i) => {
    const n = norm(i.title) + ' ' + norm(i.description || '');
    const byName = key.length > 2 && n.includes(key);
    const byRegion = norm(i.region) === regionKey;
    return byName || byRegion;
  });
  const last = related
    .map((i) => i.created_at)
    .sort()
    .reverse()[0];
  return {
    total: related.length,
    active: related.filter((i) => i.status === 'active').length,
    lastAt: last || null,
  };
}
