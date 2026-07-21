import type { Detective } from "../types.js";

export const detectives: Detective[] = [
  {
    id: "det_sherlock_holmes",
    slug: "sherlock-holmes",
    nameZh: "夏洛克·福尔摩斯",
    nameOriginal: "Sherlock Holmes",
    country: "英国",
    creatorName: "阿瑟·柯南·道尔",
    summary: "以观察、演绎和现场证据还原案件真相的咨询侦探。",
    tags: ["古典推理", "演绎法", "伦敦"],
    works: [
      {
        id: "work_a_study_in_scarlet",
        titleZh: "血字的研究",
        titleOriginal: "A Study in Scarlet",
        type: "NOVEL",
        releaseYear: 1887,
        creatorName: "阿瑟·柯南·道尔"
      },
      {
        id: "work_the_adventures_of_sherlock_holmes",
        titleZh: "福尔摩斯探案集",
        titleOriginal: "The Adventures of Sherlock Holmes",
        type: "SHORT_STORY",
        releaseYear: 1892,
        creatorName: "阿瑟·柯南·道尔"
      }
    ]
  },
  {
    id: "det_hercule_poirot",
    slug: "hercule-poirot",
    nameZh: "赫尔克里·波洛",
    nameOriginal: "Hercule Poirot",
    country: "比利时",
    creatorName: "阿加莎·克里斯蒂",
    summary: "重视秩序与心理分析，以“灰色脑细胞”破解谜案的私人侦探。",
    tags: ["黄金时代", "本格推理", "心理分析"],
    works: [
      {
        id: "work_mysterious_affair_at_styles",
        titleZh: "斯泰尔斯庄园奇案",
        titleOriginal: "The Mysterious Affair at Styles",
        type: "NOVEL",
        releaseYear: 1920,
        creatorName: "阿加莎·克里斯蒂"
      },
      {
        id: "work_murder_on_the_orient_express",
        titleZh: "东方快车谋杀案",
        titleOriginal: "Murder on the Orient Express",
        type: "NOVEL",
        releaseYear: 1934,
        creatorName: "阿加莎·克里斯蒂"
      }
    ]
  },
  {
    id: "det_kogoro_akechi",
    slug: "kogoro-akechi",
    nameZh: "明智小五郎",
    nameOriginal: "明智小五郎",
    country: "日本",
    creatorName: "江户川乱步",
    summary: "活跃于都市怪奇与犯罪谜案中的日本代表性名侦探。",
    tags: ["日本推理", "都市怪奇", "经典侦探"],
    works: [
      {
        id: "work_d_slope_murder_case",
        titleZh: "D坂杀人事件",
        titleOriginal: "D坂の殺人事件",
        type: "SHORT_STORY",
        releaseYear: 1925,
        creatorName: "江户川乱步"
      }
    ]
  }
];
