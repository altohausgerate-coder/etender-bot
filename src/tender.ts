export interface EventItem {
  eventId: number;
  eventType: number;
  buyerOrganizationName: string;
  eventName: string;
  publishDate: string;
  endDate: string;
}

export const eventUrl = (id: number) => `https://etender.gov.az/main/competition/detail/${id}`;

const TYPE_NAMES: Record<number, string> = {
  2: "Açıq tender",
  3: "İki mərhələli tender",
  4: "Kotirovka sorğusu",
  5: "Təklif sorğusu",
  6: "Açıq tender",
  7: "Açıq tender",
  9: "RT",
  10: "TST",
  13: "Tək mənbə",
};
export const typeName = (t: number) => TYPE_NAMES[t] ?? `Növ ${t}`;

// Azərbaycan hərflərini sadələşdirir ki, "temir" yazanda "təmir" də tapılsın.
const FOLD: Record<string, string> = { ə: "e", ı: "i", ö: "o", ü: "u", ş: "s", ç: "c", ğ: "g" };
export function fold(s: string): string {
  return s
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLowerCase()
    .replace(/[əıöüşçğ]/g, (c) => FOLD[c])
    .replace(/\s+/g, " ")
    .trim();
}

const haystack = (ev: EventItem) => fold(`${ev.eventName} ${ev.buyerOrganizationName}`);

export function matches(ev: EventItem, keywords: string[]): string[] {
  const hay = haystack(ev);
  return keywords.filter((k) => hay.includes(fold(k)));
}

export function search(items: EventItem[], query: string): EventItem[] {
  const q = fold(query);
  return items.filter((ev) => haystack(ev).includes(q));
}
