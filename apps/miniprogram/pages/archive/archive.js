const {
  listArchiveDirectory,
  listDetectives,
  listPictureBookEntries
} = require("../../services/api");

const categoryLabels = {
  WORLD_LITERATURE: "世界文学",
  SCREEN_DETECTIVES: "影视侦探",
  JAPANESE_POPULAR: "日本推理",
  CHINESE_LITERATURE: "华语推理",
  HISTORICAL_JUSTICE: "历史断案"
};

const subjectKindLabels = {
  FICTIONAL: "虚构人物",
  HISTORICAL: "历史人物"
};

const filterDefinitions = [
  { key: "country", facet: "countries", label: "国家/地区", allLabel: "全部国家/地区" },
  { key: "era", facet: "eras", label: "时代", allLabel: "全部时代" },
  { key: "category", facet: "categories", label: "分类", allLabel: "全部分类" },
  { key: "subjectKind", facet: "subjectKinds", label: "人物类型", allLabel: "全部人物类型" },
  { key: "tag", facet: "tags", label: "标签", allLabel: "全部标签" }
];

function emptyFilters() {
  return { country: "", era: "", category: "", subjectKind: "", tag: "" };
}

function emptyFacets() {
  return { countries: [], eras: [], categories: [], subjectKinds: [], tags: [] };
}

function filterLabel(key, value) {
  if (key === "category") return categoryLabels[value] || value;
  if (key === "subjectKind") return subjectKindLabels[value] || value;
  return value;
}

function buildFilterFields(facets, filters) {
  return filterDefinitions.map((definition) => {
    const options = [
      { value: "", label: definition.allLabel },
      ...(facets[definition.facet] || []).map((value) => ({
        value,
        label: filterLabel(definition.key, value)
      }))
    ];
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.value === filters[definition.key])
    );
    return {
      ...definition,
      options,
      selectedIndex,
      selectedLabel: options[selectedIndex].label,
      active: Boolean(filters[definition.key])
    };
  });
}

Page({
  data: {
    query: "",
    activeSection: "detectives",
    sections: [
      { id: "detectives", label: "侦探档案" },
      { id: "pictureBook", label: "图鉴索引" },
      { id: "extension", label: "扩展收录" },
      { id: "history", label: "历史断案" }
    ],
    sectionTitle: "侦探档案目录",
    searchPlaceholder: "侦探、创作者或标签",
    filtersVisible: false,
    filters: emptyFilters(),
    facets: emptyFacets(),
    filterFields: buildFilterFields(emptyFacets(), emptyFilters()),
    selectedFilterCount: 0,
    entries: [],
    coverage: null,
    coverageText: "",
    page: 1,
    hasMore: false,
    loading: true,
    loadingMore: false,
    error: ""
  },

  onLoad() {
    this.searchRequestId = 0;
    this.search();
  },

  onQueryInput(event) {
    this.setData({ query: event.detail.value });
  },

  onSearch() {
    this.search({ reset: true });
  },

  onClear() {
    this.setData({ query: "" });
    this.search({ reset: true });
  },

  onToggleFilters() {
    this.setData({ filtersVisible: !this.data.filtersVisible });
  },

  onFilterChange(event) {
    const key = event.currentTarget.dataset.key;
    const field = this.data.filterFields.find((item) => item.key === key);
    const selectedIndex = Number.parseInt(event.detail.value, 10);
    const option = field?.options[selectedIndex];
    if (!field || !option) return;

    const filters = { ...this.data.filters, [key]: option.value };
    this.setData({
      filters,
      filterFields: buildFilterFields(this.data.facets, filters),
      selectedFilterCount: Object.values(filters).filter(Boolean).length
    }, () => this.search({ reset: true }));
  },

  onClearFilters() {
    const filters = emptyFilters();
    this.setData({
      filters,
      filterFields: buildFilterFields(this.data.facets, filters),
      selectedFilterCount: 0
    }, () => this.search({ reset: true }));
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return;
    this.search({ append: true });
  },

  onReachBottom() {
    if (this.data.activeSection === "detectives") this.onLoadMore();
  },

  onSectionChange(event) {
    const section = event.currentTarget.dataset.section;
    if (!section || section === this.data.activeSection) {
      return;
    }

    const sectionConfig = {
      detectives: {
        sectionTitle: "侦探档案目录",
        searchPlaceholder: "侦探、创作者或标签"
      },
      pictureBook: {
        sectionTitle: "名侦探图鉴索引",
        searchPlaceholder: "侦探名称、别名或推荐作品"
      },
      extension: {
        sectionTitle: "档案馆扩展收录",
        searchPlaceholder: "侦探、创作者或代表作品"
      },
      history: {
        sectionTitle: "历史断案人物",
        searchPlaceholder: "历史人物、别名或相关文献"
      }
    }[section];

    this.setData({
      activeSection: section,
      query: "",
      entries: [],
      coverage: null,
      coverageText: "",
      page: 1,
      hasMore: false,
      filtersVisible: false,
      ...sectionConfig
    }, () => this.search({ reset: true }));
  },

  async search(options = {}) {
    const append = Boolean(options.append && this.data.activeSection === "detectives");
    const requestId = ++this.searchRequestId;
    this.setData(append
      ? { loadingMore: true, error: "" }
      : { loading: true, loadingMore: false, error: "" });
    try {
      if (this.data.activeSection === "detectives") {
        const page = append ? this.data.page + 1 : 1;
        const activeFilters = {};
        Object.keys(this.data.filters).forEach((key) => {
          if (this.data.filters[key]) activeFilters[key] = this.data.filters[key];
        });
        const response = await listDetectives({
          q: this.data.query,
          ...activeFilters,
          page,
          pageSize: 30
        });
        if (requestId !== this.searchRequestId) return;
        const facets = response.facets || emptyFacets();
        this.setData({
          entries: append ? [...this.data.entries, ...response.data] : response.data,
          facets,
          filterFields: buildFilterFields(facets, this.data.filters),
          selectedFilterCount: Object.values(this.data.filters).filter(Boolean).length,
          coverage: response.pagination,
          coverageText: `已发布 ${response.pagination.total} 位侦探与历史断案人物档案`,
          page,
          hasMore: page < response.pagination.totalPages
        });
        return;
      }
      if (this.data.activeSection === "pictureBook") {
        const response = await listPictureBookEntries({ q: this.data.query, pageSize: 150 });
        if (requestId !== this.searchRequestId) return;
        this.setData({
          entries: response.data,
          coverage: response.coverage,
          coverageText: `已收录第 1～${response.coverage.latestPublishedVolume} 卷，共 ${response.coverage.entryCount} 条图鉴记录`,
          page: 1,
          hasMore: false
        });
        return;
      }

      const collection = this.data.activeSection === "history"
        ? "HISTORICAL_CASES"
        : "ARCHIVE_EXTENSION";
      const response = await listArchiveDirectory({
        q: this.data.query,
        collection,
        pageSize: 50
      });
      if (requestId !== this.searchRequestId) return;
      const entries = response.data.map((entry) => ({
        ...entry,
        categoryLabel: categoryLabels[entry.category] || "扩展档案",
        collectionLabel: entry.collection === "HISTORICAL_CASES" ? "史实" : "扩展"
      }));
      const coverageText = this.data.activeSection === "history"
        ? `已收录 ${response.coverage.historicalCount} 位历史断案人物，史实与文学改编分开说明`
        : `已收录 ${response.coverage.extensionCount} 位图鉴之外的知名虚构侦探`;
      this.setData({
        entries,
        coverage: response.coverage,
        coverageText,
        page: 1,
        hasMore: false
      });
    } catch (error) {
      if (requestId === this.searchRequestId) {
        this.setData({ error: error.message || "搜索失败" });
      }
    } finally {
      if (requestId === this.searchRequestId) {
        this.setData({ loading: false, loadingMore: false });
      }
    }
  },

  openEntry(event) {
    const { slug, id, name } = event.currentTarget.dataset;
    if (this.data.activeSection === "detectives") {
      if (slug) wx.navigateTo({ url: `/pages/detective/detective?slug=${slug}` });
      return;
    }
    if (this.data.activeSection !== "pictureBook") {
      const entry = this.data.entries.find((item) => item.id === id);
      if (!entry) {
        return;
      }
      const workLabel = entry.collection === "HISTORICAL_CASES" ? "相关文献" : "代表作品";
      const creatorLine = entry.creatorName ? `创作者：${entry.creatorName}\n` : "";
      wx.showModal({
        title: `${entry.id} · ${entry.names.zh}`,
        content: `${creatorLine}${entry.summary}\n\n${workLabel}：${entry.featuredWorks.join("、")}`,
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }

    if (slug) {
      wx.navigateTo({ url: `/pages/detective/detective?slug=${slug}` });
      return;
    }

    wx.showModal({
      title: `${id} · ${name}`,
      content: "卷号索引已经收录，人物生平、代表案件与作品信息正在逐条核验。",
      showCancel: false,
      confirmText: "知道了"
    });
  }
});
