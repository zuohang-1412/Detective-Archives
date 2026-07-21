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
    entries: [],
    coverage: null,
    coverageText: "",
    loading: true,
    error: ""
  },

  onLoad() {
    this.search();
  },

  onQueryInput(event) {
    this.setData({ query: event.detail.value });
  },

  onSearch() {
    this.search();
  },

  onClear() {
    this.setData({ query: "" });
    this.search();
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
      ...sectionConfig
    }, () => this.search());
  },

  async search() {
    this.setData({ loading: true, error: "" });
    try {
      if (this.data.activeSection === "detectives") {
        const response = await listDetectives({ q: this.data.query, pageSize: 50 });
        this.setData({
          entries: response.data,
          coverage: response.pagination,
          coverageText: `已发布 ${response.pagination.total} 位侦探与历史断案人物档案`
        });
        return;
      }
      if (this.data.activeSection === "pictureBook") {
        const response = await listPictureBookEntries({ q: this.data.query, pageSize: 150 });
        this.setData({
          entries: response.data,
          coverage: response.coverage,
          coverageText: `已收录第 1～${response.coverage.latestPublishedVolume} 卷，共 ${response.coverage.entryCount} 条图鉴记录`
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
      const entries = response.data.map((entry) => ({
        ...entry,
        categoryLabel: categoryLabels[entry.category] || "扩展档案",
        collectionLabel: entry.collection === "HISTORICAL_CASES" ? "史实" : "扩展"
      }));
      const coverageText = this.data.activeSection === "history"
        ? `已收录 ${response.coverage.historicalCount} 位历史断案人物，史实与文学改编分开说明`
        : `已收录 ${response.coverage.extensionCount} 位图鉴之外的知名虚构侦探`;
      this.setData({ entries, coverage: response.coverage, coverageText });
    } catch (error) {
      this.setData({ error: error.message || "搜索失败" });
    } finally {
      this.setData({ loading: false });
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
