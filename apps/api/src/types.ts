export type MediaType =
  | "NOVEL"
  | "SHORT_STORY"
  | "COMIC"
  | "FILM"
  | "SERIES"
  | "ANIMATION"
  | "GAME"
  | "OTHER";

export interface WorkSummary {
  id: string;
  slug: string;
  titleZh: string;
  titleOriginal: string;
  type: MediaType;
  releaseYear: number;
  creatorName: string;
}

export interface Detective {
  id: string;
  slug: string;
  nameZh: string;
  nameOriginal: string;
  country: string;
  creatorName: string;
  summary: string;
  tags: string[];
  works: WorkSummary[];
}
