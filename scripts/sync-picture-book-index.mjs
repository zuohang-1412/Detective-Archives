import { writeFile } from "node:fs/promises";
import path from "node:path";

const BILIBILI_URL = "https://www.bilibili.com/opus/636222280260648982";
const TIEBA_URL = "https://tieba.baidu.com/p/1501858385";
const OUTPUT_PATH = path.resolve("apps/api/src/data/picture-book-index.json");
const SNAPSHOT_DATE = "2026-07-21";

const digitMap = new Map([
  ["零", 0],
  ["〇", 0],
  ["一", 1],
  ["二", 2],
  ["两", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9]
]);

function chineseNumberToInteger(value) {
  if (value.includes("百")) {
    const [hundreds, remainder = ""] = value.split("百");
    return (digitMap.get(hundreds) ?? 1) * 100 + (remainder ? chineseNumberToInteger(remainder) : 0);
  }

  if (value.includes("十")) {
    const [tens, ones = ""] = value.split("十");
    return (tens ? digitMap.get(tens) : 1) * 10 + (ones ? digitMap.get(ones) : 0);
  }

  const parsed = digitMap.get(value);
  if (parsed === undefined) {
    throw new Error(`Unsupported Chinese number: ${value}`);
  }
  return parsed;
}

function splitNameAndAliases(sourceName) {
  const parenthetical = sourceName.match(/（(.+)）$/);
  if (!parenthetical) {
    return { canonicalNameZh: sourceName.trim(), aliases: [] };
  }

  const alias = parenthetical[1]
    .replace(/^也翻译为[“"]?/, "")
    .replace(/[”"]$/, "")
    .trim();

  return {
    canonicalNameZh: sourceName.slice(0, parenthetical.index).trim(),
    aliases: alias ? [alias] : []
  };
}

function extractInitialState(html) {
  const marker = "__INITIAL_STATE__=";
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error("Bilibili page did not contain __INITIAL_STATE__");
  }

  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";(function", jsonStart);
  if (jsonEnd < 0) {
    throw new Error("Bilibili initial state terminator was not found");
  }

  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

function extractParagraphText(initialState) {
  const contentModule = initialState.detail?.modules?.find(
    (module) => module.module_type === "MODULE_TYPE_CONTENT"
  );
  const paragraphs = contentModule?.module_content?.paragraphs;
  if (!Array.isArray(paragraphs)) {
    throw new Error("Bilibili article content was not found");
  }

  return paragraphs
    .map((paragraph) =>
      (paragraph.text?.nodes ?? [])
        .map((node) => node.word?.words ?? "")
        .join("")
        .trim()
    )
    .filter(Boolean);
}

function makeId(volumeNo, edition) {
  return `PB-${String(volumeNo).padStart(3, "0")}-${edition === "SPECIAL" ? "SP" : "STD"}`;
}

function extractBilibiliEntries(paragraphs) {
  const headingPattern = /^第([一二三四五六七八九十百零〇两]+)卷(?:名)?侦探图鉴[：:]?\s*(.+)$/;
  const entries = [];

  for (let index = 0; index < paragraphs.length; index += 1) {
    const heading = paragraphs[index].match(headingPattern);
    if (!heading) {
      continue;
    }

    const volumeNo = chineseNumberToInteger(heading[1]);
    const nextHeadingOffset = paragraphs
      .slice(index + 1)
      .findIndex((paragraph) => headingPattern.test(paragraph));
    const blockEnd = nextHeadingOffset < 0 ? paragraphs.length : index + 1 + nextHeadingOffset;
    const descriptionBlock = paragraphs.slice(index + 1, blockEnd).join("\n");
    const recommendedWorks = [
      ...descriptionBlock.matchAll(/推荐作品[：:]?《([^》]+)》/g)
    ].map((match) => match[1].trim());
    const sourceName = heading[2].trim();
    const { canonicalNameZh, aliases } = splitNameAndAliases(sourceName);

    entries.push({
      id: makeId(volumeNo, "STANDARD"),
      volumeNo,
      edition: "STANDARD",
      names: {
        zh: canonicalNameZh,
        original: null,
        en: null,
        sourceLabel: sourceName,
        aliases
      },
      recommendedWorks,
      detectiveSlug: volumeNo === 1
        ? "sherlock-holmes"
        : volumeNo === 2
          ? "kogoro-akechi"
          : volumeNo === 3
            ? "hercule-poirot"
            : null,
      releaseDate: null,
      sourceIds: ["bilibili-opus-636222280260648982"],
      sourceUrls: [BILIBILI_URL],
      verification: {
        identity: "SOURCE_CAPTURED",
        recommendedWorks: recommendedWorks.length > 0 ? "SOURCE_CAPTURED" : "MISSING"
      }
    });
  }

  const volumes = new Set(entries.map((entry) => entry.volumeNo));
  const missingVolumes = Array.from({ length: 100 }, (_, index) => index + 1).filter(
    (volume) => !volumes.has(volume)
  );
  if (entries.length !== 100 || missingVolumes.length > 0) {
    throw new Error(
      `Expected volumes 1-100, got ${entries.length} entries; missing: ${missingVolumes.join(", ")}`
    );
  }

  return entries.sort((left, right) => left.volumeNo - right.volumeNo);
}

const supplementalEntries = [
  {
    volumeNo: 101,
    edition: "STANDARD",
    zh: "岸边露伴",
    original: "岸辺露伴",
    en: "Rohan Kishibe",
    releaseDate: "2022-04-13"
  },
  {
    volumeNo: 102,
    edition: "STANDARD",
    zh: "藤圣子",
    original: "藤 聖子",
    en: "Seiko Fuji",
    releaseDate: "2022-09-15"
  },
  {
    volumeNo: 103,
    edition: "STANDARD",
    zh: "雷顿教授",
    original: "レイトン教授",
    en: "Professor Layton",
    releaseDate: "2023-04-12"
  },
  {
    volumeNo: 104,
    edition: "STANDARD",
    zh: "榊真理子",
    original: "榊マリコ",
    en: "Mariko Sakaki",
    releaseDate: "2023-10-18"
  },
  {
    volumeNo: 105,
    edition: "STANDARD",
    zh: "轮堂鸦夜",
    original: "輪堂鴉夜",
    en: "Aya Rindo",
    releaseDate: "2024-04-10"
  },
  {
    volumeNo: 105,
    edition: "SPECIAL",
    zh: "工藤新一",
    original: "工藤新一",
    en: "Shinichi Kudo",
    releaseDate: "2024-04-10",
    primarySource: true,
    sourceUrl: "https://shogakukan-comic.jp/book?isbn=9784099431549"
  },
  {
    volumeNo: 106,
    edition: "STANDARD",
    zh: "成步堂龙一",
    original: "成歩堂龍一",
    en: "Phoenix Wright",
    releaseDate: "2024-10-18"
  },
  {
    volumeNo: 107,
    edition: "STANDARD",
    zh: "狡噛慎也",
    original: "狡噛慎也",
    en: "Shinya Kogami",
    releaseDate: "2025-04-18"
  },
  {
    volumeNo: 108,
    edition: "STANDARD",
    zh: "天久鹰央",
    original: "天久鷹央",
    en: "Takao Ameku",
    releaseDate: "2026-04-08"
  }
].map((entry) => {
  const sourceUrl = entry.sourceUrl
    ?? `https://www.detectiveconanworld.com/wiki/Volume_${entry.volumeNo}`;
  const sourceId = entry.primarySource
    ? "shogakukan-volume-105-special"
    : "detective-conan-world-volume-pages";

  return {
    id: makeId(entry.volumeNo, entry.edition),
    volumeNo: entry.volumeNo,
    edition: entry.edition,
    names: {
      zh: entry.zh,
      original: entry.original,
      en: entry.en,
      sourceLabel: entry.en,
      aliases: []
    },
    recommendedWorks: [],
    detectiveSlug: null,
    releaseDate: entry.releaseDate,
    sourceIds: [sourceId],
    sourceUrls: [sourceUrl],
    verification: {
      identity: entry.primarySource ? "PRIMARY_SOURCE_CONFIRMED" : "SOURCE_CAPTURED",
      recommendedWorks: "MISSING"
    }
  };
});

const response = await fetch(BILIBILI_URL, {
  headers: { "user-agent": "Mozilla/5.0 DetectiveArchivesCatalogSync/1.0" }
});
if (!response.ok) {
  throw new Error(`Bilibili responded with ${response.status}`);
}

const initialState = extractInitialState(await response.text());
const bilibiliEntries = extractBilibiliEntries(extractParagraphText(initialState));
const editionOrder = { STANDARD: 0, SPECIAL: 1 };
const entries = [...bilibiliEntries, ...supplementalEntries].sort(
  (left, right) => left.volumeNo - right.volumeNo || editionOrder[left.edition] - editionOrder[right.edition]
);

const catalog = {
  schemaVersion: 1,
  snapshotDate: SNAPSHOT_DATE,
  contentPolicy: "Only factual index fields are stored; source descriptions and images are not copied.",
  coverage: {
    firstVolume: 1,
    latestPublishedVolume: 108,
    standardVolumeCount: 108,
    entryCount: entries.length,
    entriesWithRecommendedWorks: entries.filter((entry) => entry.recommendedWorks.length > 0).length
  },
  sources: [
    {
      id: "bilibili-opus-636222280260648982",
      label: "Bilibili 名侦探图鉴整理",
      url: BILIBILI_URL,
      role: "Volumes 1-100 index and recommended-work extraction",
      quality: "COMMUNITY_INDEX"
    },
    {
      id: "baidu-tieba-1501858385",
      label: "百度贴吧名侦探图鉴整理",
      url: TIEBA_URL,
      role: "User-provided cross-check candidate; not used by the automated extractor",
      quality: "COMMUNITY_INDEX"
    },
    {
      id: "detective-conan-world-volume-pages",
      label: "Detective Conan Wiki volume pages",
      url: "https://www.detectiveconanworld.com/wiki/Volume_101",
      role: "Volumes 101-108 detective and release-date index",
      quality: "COMMUNITY_WIKI"
    },
    {
      id: "shogakukan-volume-105-special",
      label: "小学馆《名侦探柯南》105 卷特装版",
      url: "https://shogakukan-comic.jp/book?isbn=9784099431549",
      role: "Volume 105 special-edition detective confirmation",
      quality: "PUBLISHER"
    },
    {
      id: "shogakukan-series",
      label: "小学馆《名侦探柯南》既刊一覧",
      url: "https://shogakukan-comic.jp/book-series?cd=13900",
      role: "Latest published volume boundary",
      quality: "PUBLISHER"
    }
  ],
  entries
};

await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${entries.length} entries covering volumes 1-${catalog.coverage.latestPublishedVolume} to ${OUTPUT_PATH}`
);
