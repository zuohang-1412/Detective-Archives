const { listDetectives } = require("../../services/api");

Page({
  data: {
    detectives: [],
    loading: true,
    error: ""
  },

  onLoad() {
    this.loadFeatured();
  },

  onPullDownRefresh() {
    this.loadFeatured().finally(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    return {
      title: "侦探档案馆｜发现经典侦探与推理作品",
      path: "/pages/home/home"
    };
  },

  async loadFeatured() {
    this.setData({ loading: true, error: "" });
    try {
      const response = await listDetectives({ pageSize: 3 });
      this.setData({ detectives: response.data });
    } catch (error) {
      this.setData({ error: error.message || "暂时无法读取档案" });
    } finally {
      this.setData({ loading: false });
    }
  },

  openArchive() {
    wx.switchTab({ url: "/pages/archive/archive" });
  },

  openDetective(event) {
    const { slug } = event.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/detective/detective?slug=${slug}` });
  }
});
