const {
  getShelfItem,
  getWork,
  hasAuthToken,
  removeShelfItem,
  updateShelfItem
} = require("../../services/api");

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
    shelfItem: null,
    shelfUpdating: false,
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
      if (hasAuthToken()) {
        await this.loadShelfItem(work.id);
      }
    } catch (error) {
      this.setData({ error: error.message || "作品资料读取失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadShelfItem(workId) {
    try {
      const response = await getShelfItem(workId);
      this.setData({ shelfItem: response.data });
    } catch (error) {
      if (error.statusCode !== 401) {
        wx.showToast({ title: "阅读状态读取失败", icon: "none" });
      }
    }
  },

  async setShelfStatus(event) {
    if (this.data.shelfUpdating || !this.data.work) return;
    if (!hasAuthToken()) {
      wx.showModal({
        title: "登录后记录",
        content: "前往“我的档案馆”完成微信登录，即可保存阅读或观看进度。",
        confirmText: "去登录",
        success: (result) => {
          if (result.confirm) wx.switchTab({ url: "/pages/me/me" });
        }
      });
      return;
    }
    const { status } = event.currentTarget.dataset;
    this.setData({ shelfUpdating: true });
    try {
      const response = await updateShelfItem(this.data.work.id, { status });
      this.setData({ shelfItem: response.data });
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error.message || "保存失败", icon: "none" });
    } finally {
      this.setData({ shelfUpdating: false });
    }
  },

  async removeFromShelf() {
    if (this.data.shelfUpdating || !this.data.work) return;
    this.setData({ shelfUpdating: true });
    try {
      await removeShelfItem(this.data.work.id);
      this.setData({ shelfItem: null });
      wx.showToast({ title: "已移出档案馆", icon: "none" });
    } catch (error) {
      wx.showToast({ title: error.message || "操作失败", icon: "none" });
    } finally {
      this.setData({ shelfUpdating: false });
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
