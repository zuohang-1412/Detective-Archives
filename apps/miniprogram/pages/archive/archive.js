const { listDetectives } = require("../../services/api");

Page({
  data: {
    query: "",
    detectives: [],
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
      const response = await listDetectives({ q: this.data.query, pageSize: 50 });
      this.setData({ detectives: response.data });
    } catch (error) {
      this.setData({ error: error.message || "搜索失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  openDetective(event) {
    const { slug } = event.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/detective/detective?slug=${slug}` });
  }
});
