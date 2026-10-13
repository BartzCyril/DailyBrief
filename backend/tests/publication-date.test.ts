import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { parsePublicationDate, parsePublicationDateCandidates } from "../src/publication-date";
import { hasPublicationDate } from "../src/selector-scraping";

const timezone = "Europe/Paris";
test.each([
  ["24 Sept. 2026", "2026-09-23T22:00:00.000Z"],
  ["08.10.2026", "2026-10-07T22:00:00.000Z"],
  ["Publié le 29 septembre 2026", "2026-09-28T22:00:00.000Z"],
  ["Modifié le 25 septembre 2026", "2026-09-24T22:00:00.000Z"],
  ["MODIFIÉE LE\u202f25\u00a0SEPT.\u00a02026", "2026-09-24T22:00:00.000Z"],
  ["Modifié le 25 septembre 2026 à 08h18", "2026-09-25T06:18:00.000Z"],
  ["Publié le 29 septembre 2026, modifié le 30 septembre 2026", "2026-09-28T22:00:00.000Z"],
  [
    "Publié le 29 septembre 2026 à 01h33 ; mis à jour le 30 septembre 2026 à 08h18",
    "2026-09-28T23:33:00.000Z",
  ],
  ["PUBLIÉ LE\u202f29\u00a0SEPT.\u00a02026", "2026-09-28T22:00:00.000Z"],
  ["Date de publication : jeudi 8 octobre 2026", "2026-10-07T22:00:00.000Z"],
  ["Mise en ligne le 8 oct. 2026 à 8 h 05", "2026-10-08T06:05:00.000Z"],
  ["Mis à jour le 08-10-2026 à 15h30", "2026-10-08T13:30:00.000Z"],
  ["1er FÉVR. 2024", "2024-01-31T23:00:00.000Z"],
  ["29 février 2024", "2024-02-28T23:00:00.000Z"],
  ["1er août 2026", "2026-07-31T22:00:00.000Z"],
  ["8 oct 2026 à 15:30:12.125", "2026-10-08T13:30:12.125Z"],
  ["2026/10/08", "2026-10-07T22:00:00.000Z"],
  ["2026.10.08 15:30", "2026-10-08T13:30:00.000Z"],
  ["8/10/2026", "2026-10-07T22:00:00.000Z"],
  ["10/29/2026", "2026-10-28T23:00:00.000Z"],
  ["October 8, 2026", "2026-10-07T22:00:00.000Z"],
  ["Mar 8, 2026", "2026-03-07T23:00:00.000Z"],
  ["mar. 08.10.2026", "2026-10-07T22:00:00.000Z"],
  ["Oct. 8th, 2026 at 3:30 PM", "2026-10-08T13:30:00.000Z"],
  ["8th October 2026", "2026-10-07T22:00:00.000Z"],
  ["Published on 8 Oct 2026 at 10:30 UTC", "2026-10-08T10:30:00.000Z"],
  ["Publié le 8 octobre 2026 · 3 min de lecture", "2026-10-07T22:00:00.000Z"],
  ["Publié le 8 octobre 2026 par Un auteur", "2026-10-07T22:00:00.000Z"],
  ["2026-10-08T10:30:12+02:00", "2026-10-08T08:30:12.000Z"],
  ["2026-10-08t10:30:12z", "2026-10-08T10:30:12.000Z"],
  ["20261008", "2026-10-07T22:00:00.000Z"],
  ["2026-10-08 10:30:12", "2026-10-08T08:30:12.000Z"],
  ["2026-10-08 10:30:12 CET", "2026-10-08T09:30:12.000Z"],
  ["8 octobre 2026 10:30 GMT+0200", "2026-10-08T08:30:00.000Z"],
  ["8 octobre 2026 10:30 CET", "2026-10-08T09:30:00.000Z"],
  ["8 octobre 2026 10:30 CEST", "2026-10-08T08:30:00.000Z"],
  ["Thu, 08 Oct 2026 10:30:00 GMT", "2026-10-08T10:30:00.000Z"],
  ["Tue, 08 Oct 2026 10:30:00 GMT", "2026-10-08T10:30:00.000Z"],
])("normalizes publication date %s", (value, expected) => {
  expect(parsePublicationDate(value!, timezone)).toBe(expected!);
});

test.each([
  "",
  "2026",
  "2026-10",
  "15:30",
  "8 octobre",
  "Octobre 2026",
  "08/10/26",
  "31.02.2026",
  "29 février 2026",
  "31 avril 2026",
  "2026-02-31",
  "00/10/2026",
  "08/00/2026",
  "8 octobre 2026 25:30",
  "8 octobre 2026 15:60",
  "8 octobre 2026 15:30 +99:00",
  "Du 8 octobre 2026 au 12 octobre 2026",
  "Une conférence le 8 octobre 2026",
  "3 min de lecture",
  "Modifié le 31 février 2026",
  "Modifié à 08h18",
  "Publié le 31 février 2026, modifié le 25 septembre 2026",
  "Publié aujourd’hui à 25h33, modifié à 08h18",
  "Publié le 29 septembre 2026, publié le 30 septembre 2026",
])("does not invent or roll over invalid/ambiguous date %s", (value) => {
  expect(parsePublicationDate(value, timezone)).toBeNull();
});

test("relative publication dates use an explicit reference and the user's calendar day", () => {
  const reference = new Date("2026-10-11T23:30:00Z");
  expect(parsePublicationDate("Aujourd’hui", timezone, reference)).toBe("2026-10-11T22:00:00.000Z");
  expect(parsePublicationDate("hier à 15h30", timezone, reference)).toBe(
    "2026-10-11T13:30:00.000Z",
  );
  expect(parsePublicationDate("il y a 2 heures", timezone, reference)).toBe(
    "2026-10-11T21:30:00.000Z",
  );
  expect(parsePublicationDate("2 days ago", timezone, reference)).toBe("2026-10-09T23:30:00.000Z");
});

test.each([
  ["Publié aujourd’hui à 01h33, modifié à 08h18", "2026-10-11T23:33:00.000Z"],
  ["Publié aujourd'hui à 01 h 33 · Modifié à 08 h 18", "2026-10-11T23:33:00.000Z"],
  ["Publié hier à 23h33, modifié aujourd’hui à 08h18", "2026-10-11T21:33:00.000Z"],
  ["Publié il y a 2 heures, modifié il y a 1 heure", "2026-10-11T21:30:00.000Z"],
  ["Published today at 01:33, updated at 08:18", "2026-10-11T23:33:00.000Z"],
])("retains publication time in compound metadata: %s", (value, expected) => {
  const reference = new Date("2026-10-11T23:30:00Z");
  expect(parsePublicationDate(value!, timezone, reference)).toBe(expected!);
});

test("publication dates use the requested zone instead of the host timezone", () => {
  expect(parsePublicationDate("08.10.2026", "America/New_York")).toBe("2026-10-08T04:00:00.000Z");
  expect(parsePublicationDate("25.10.2026 15:30", timezone)).toBe("2026-10-25T14:30:00.000Z");
  expect(parsePublicationDate("08.10.2026", "invalid/timezone")).toBeNull();
});

test("a blank or malformed machine attribute falls back to the visible date", () => {
  expect(
    parsePublicationDateCandidates(["", "not-a-date", "Publié le 29 septembre 2026"], timezone),
  ).toBe("2026-09-28T22:00:00.000Z");
  expect(
    parsePublicationDateCandidates(
      ["2026-09-29T12:30:00Z", "Publié le 29 septembre 2026"],
      timezone,
    ),
  ).toBe("2026-09-29T12:30:00.000Z");
});

test("selector validation uses the same calendar parser as collection, including machine attributes", () => {
  const document = new JSDOM(`<main>
    <p class="date">24 Sept. 2026</p><p class="date">08.10.2026</p>
    <p class="date" datetime="">Publié le 29 septembre 2026</p>
    <p class="date">Modifié le 25 septembre 2026</p>
    <p class="date"><span>Publié aujourd’hui à 01h33</span>, <span>modifié à 08h18</span></p>
    <meta itemprop="datePublished" content="2026-10-08T12:30:00Z">
    <time datetime="not-a-date">08.10.2026</time>
    <p class="invalid">31.02.2026</p><p class="invalid">2026</p>
  </main>`).window.document;
  for (const element of document.querySelectorAll(".date, meta, time"))
    expect(hasPublicationDate(element)).toBe(true);
  for (const element of document.querySelectorAll(".invalid"))
    expect(hasPublicationDate(element)).toBe(false);
});
