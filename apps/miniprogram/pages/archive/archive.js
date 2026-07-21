const { listPictureBookEntries } = require("../../services/api");

Page({
  data: {
    query: "",
    entries: [],
    coverage: null,
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

  async search() {
    this.setData({ loading: true, error: "" });
    try {
      const response = await listPictureBookEntries({ q: this.data.query, pageSize: 150 });
      this.setData({ entries: response.data, coverage: response.coverage });
    } catch (error) {
      this.setData({ error: error.message || "搜索失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  openEntry(event) {
    const { slug, id, name } = event.currentTarget.dataset;
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
