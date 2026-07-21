const {
  createWorkLinkFeedback,
  getShelfItem,
  getWork,
  hasAuthToken,
  listReviews,
  removeShelfItem,
  trackWorkLinkClick,
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
    reviews: [],
    reviewPage: 1,
    reviewsHasMore: false,
    reviewsLoading: false,
    reviewsLoadingMore: false,
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
      await this.loadReviews(work.id);
    } catch (error) {
      this.setData({ error: error.message || "作品资料读取失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadReviews(workId, page = 1, append = false) {
    this.setData(append ? { reviewsLoadingMore: true } : { reviewsLoading: true });
    try {
      const response = await listReviews(workId, { page, pageSize: 10 });
      const reviews = response.data.map((review) => ({
        ...review,
        spoilerRevealed: !review.containsSpoiler
      }));
      this.setData({
        reviews: append ? [...this.data.reviews, ...reviews] : reviews,
        reviewPage: page,
        reviewsHasMore: page < response.pagination.totalPages
      });
    } catch (error) {
      if (!append) this.setData({ reviews: [] });
      else wx.showToast({ title: "更多评价读取失败", icon: "none" });
    } finally {
      this.setData(append ? { reviewsLoadingMore: false } : { reviewsLoading: false });
    }
  },

  loadMoreReviews() {
    if (
      !this.data.work
      || !this.data.reviewsHasMore
      || this.data.reviewsLoading
      || this.data.reviewsLoadingMore
    ) return;
    this.loadReviews(this.data.work.id, this.data.reviewPage + 1, true);
  },

  writeReview() {
    if (!this.data.work) return;
    if (!hasAuthToken()) {
      wx.showModal({
        title: "登录后写评价",
        content: "前往“我的档案馆”完成微信登录。",
        confirmText: "去登录",
        success: (result) => {
          if (result.confirm) wx.switchTab({ url: "/pages/me/me" });
        }
      });
      return;
    }
    wx.navigateTo({
      url: `/pages/review-editor/review-editor?workId=${encodeURIComponent(this.data.work.id)}&title=${encodeURIComponent(this.data.work.titleZh)}`
    });
  },

  openReview(event) {
    const { reviewId } = event.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/review-detail/review-detail?reviewId=${encodeURIComponent(reviewId)}` });
  },

  revealReview(event) {
    const { index } = event.currentTarget.dataset;
    this.setData({ [`reviews[${index}].spoilerRevealed`]: true });
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

  async copyOfficialLink(event) {
    const { linkId, url, provider } = event.currentTarget.dataset;
    if (!url) return;
    let targetUrl = url;
    if (linkId) {
      try {
        const response = await trackWorkLinkClick(linkId);
        if (!response.data.url) throw new Error("链接已失效或暂不可用");
        targetUrl = response.data.url;
      } catch (error) {
        wx.showModal({
          title: "链接已失效或暂不可用",
          content: "无法继续打开这条正版渠道。你可以在当前页面提交链接反馈，我们会人工复核。",
          showCancel: false,
          confirmText: "知道了"
        });
        return;
      }
    }
    wx.setClipboardData({
      data: targetUrl,
      success() {
        wx.showModal({
          title: `已复制 ${provider || "正版渠道"} 链接`,
          content: "请在浏览器中打开。渠道内容、价格和可用地区以对方页面为准。",
          showCancel: false,
          confirmText: "知道了"
        });
      }
    });
  },

  reportOfficialLink(event) {
    const { linkId, provider } = event.currentTarget.dataset;
    if (!linkId) return;
    const choices = [
      ["链接打不开", "BROKEN"],
      ["跳转内容不正确", "WRONG_DESTINATION"],
      ["当前地区不可用", "REGION_UNAVAILABLE"],
      ["可能存在版权问题", "COPYRIGHT_CONCERN"],
      ["其他问题", "OTHER"]
    ];
    wx.showActionSheet({
      itemList: choices.map((item) => item[0]),
      success: (selection) => {
        const selected = choices[selection.tapIndex];
        if (!selected) return;
        wx.showModal({
          title: `反馈 ${provider || "正版渠道"}`,
          content: `确认提交“${selected[0]}”吗？我们会在后台复核。`,
          confirmText: "提交反馈",
          success: async (result) => {
            if (!result.confirm) return;
            try {
              await createWorkLinkFeedback(linkId, { reasonCode: selected[1] });
              wx.showToast({ title: "反馈已提交", icon: "success" });
            } catch (error) {
              wx.showToast({ title: error.message || "反馈失败", icon: "none" });
            }
          }
        });
      }
    });
  }
});
