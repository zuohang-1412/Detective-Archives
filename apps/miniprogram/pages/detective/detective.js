const { getDetective } = require("../../services/api");

Page({
  data: {
    detective: null,
    loading: true,
    error: ""
  },

  onLoad(options) {
    if (!options.slug) {
      this.setData({ loading: false, error: "缺少档案标识" });
      return;
    }
    this.loadDetective(options.slug);
  },

  async loadDetective(slug) {
    this.setData({ loading: true, error: "" });
    try {
      const response = await getDetective(slug);
      this.setData({ detective: response.data });
      wx.setNavigationBarTitle({ title: response.data.nameZh });
    } catch (error) {
      this.setData({ error: error.message || "档案读取失败" });
    } finally {
      this.setData({ loading: false });
    }
  }
});
