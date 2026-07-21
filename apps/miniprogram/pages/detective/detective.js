const { getDetective } = require("../../services/api");

Page({
  data: {
    slug: "",
    detective: null,
    loading: true,
    error: ""
  },

  onLoad(options) {
    if (!options.slug) {
      this.setData({ loading: false, error: "缺少档案标识" });
      return;
    }
    this.setData({ slug: options.slug });
    this.loadDetective();
  },

  async loadDetective() {
    if (!this.data.slug) return;
    this.setData({ loading: true, error: "" });
    try {
      const response = await getDetective(this.data.slug);
      this.setData({ detective: response.data });
      wx.setNavigationBarTitle({ title: response.data.nameZh });
    } catch (error) {
      this.setData({ error: error.message || "档案读取失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  retryLoad() {
    return this.loadDetective();
  },

  returnToArchive() {
    wx.switchTab({ url: "/pages/archive/archive" });
  },

  openWork(event) {
    const { slug } = event.currentTarget.dataset;
    if (!slug) {
      wx.showToast({ title: "作品资料待补充", icon: "none" });
      return;
    }
    wx.navigateTo({ url: `/pages/work/work?slug=${encodeURIComponent(slug)}` });
  }
});
