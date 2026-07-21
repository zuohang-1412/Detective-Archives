const { getWork } = require("../../services/api");

const typeLabels = {
  NOVEL: "长篇小说",
  SHORT_STORY: "短篇小说",
  COMIC: "漫画",
  FILM: "电影",
  SERIES: "剧集",
  ANIMATION: "动画",
  GAME: "游戏",
  OTHER: "其他"
};

Page({
  data: {
    slug: "",
    work: null,
    loading: true,
    error: ""
  },

  onLoad(options) {
    if (!options.slug) {
      this.setData({ loading: false, error: "缺少作品标识" });
      return;
    }
    this.setData({ slug: options.slug });
    this.loadWork();
  },

  onPullDownRefresh() {
    this.loadWork().finally(() => wx.stopPullDownRefresh());
  },

  async loadWork() {
    this.setData({ loading: true, error: "" });
    try {
      const response = await getWork(this.data.slug);
      const work = {
        ...response.data,
        typeLabel: typeLabels[response.data.type] || "作品"
      };
      this.setData({ work });
      wx.setNavigationBarTitle({ title: work.titleZh });
    } catch (error) {
      this.setData({ error: error.message || "作品资料读取失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  openDetective(event) {
    const { slug } = event.currentTarget.dataset;
    if (slug) {
      wx.navigateTo({ url: `/pages/detective/detective?slug=${encodeURIComponent(slug)}` });
    }
  },

  copyOfficialLink(event) {
    const { url, provider } = event.currentTarget.dataset;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success() {
        wx.showModal({
          title: `已复制 ${provider || "正版渠道"} 链接`,
          content: "请在浏览器中打开。渠道内容、价格和可用地区以对方页面为准。",
          showCancel: false,
          confirmText: "知道了"
        });
      }
    });
  }
});
