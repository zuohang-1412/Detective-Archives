const {
  getCurrentUser,
  hasAuthToken,
  listMyReviews,
  listShelf,
  loginWechat,
  logout,
  updateShelfItem
} = require("../../services/api");

const statusLabels = {
  WISHLIST: "想读",
  IN_PROGRESS: "在读",
  COMPLETED: "已读",
  PAUSED: "暂停",
  DROPPED: "搁置"
};

Page({
  data: {
    loggedIn: false,
    user: null,
    items: [],
    reviews: [],
    activeStatus: "",
    tabs: [
      { status: "", label: "全部" },
      { status: "WISHLIST", label: "想读" },
      { status: "IN_PROGRESS", label: "在读" },
      { status: "COMPLETED", label: "已读" }
    ],
    loading: false,
    loggingIn: false,
    error: ""
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    if (!hasAuthToken()) {
      this.setData({ loggedIn: false, user: null, items: [], reviews: [], loading: false });
      return;
    }
    this.setData({ loading: true, error: "" });
    try {
      const [userResponse, shelfResponse, reviewResponse] = await Promise.all([
        getCurrentUser(),
        listShelf(this.data.activeStatus),
        listMyReviews()
      ]);
      const items = shelfResponse.data.map((item) => ({
        ...item,
        statusLabel: statusLabels[item.status] || item.status
      }));
      const reviewStatusLabels = {
        PENDING_REVIEW: "待审核",
        PUBLISHED: "已发布",
        REJECTED: "未通过",
        HIDDEN: "已隐藏"
      };
      const reviews = reviewResponse.data.map((review) => ({
        ...review,
        statusLabel: reviewStatusLabels[review.status] || review.status
      }));
      this.setData({ loggedIn: true, user: userResponse.data, items, reviews });
    } catch (error) {
      this.setData({
        loggedIn: hasAuthToken(),
        error: error.message || "档案馆读取失败"
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async login() {
    if (this.data.loggingIn) return;
    this.setData({ loggingIn: true, error: "" });
    try {
      await loginWechat();
      await this.refresh();
      wx.showToast({ title: "登录成功", icon: "success" });
    } catch (error) {
      this.setData({ error: error.message || "登录失败" });
    } finally {
      this.setData({ loggingIn: false });
    }
  },

  confirmLogout() {
    wx.showModal({
      title: "退出登录",
      content: "退出后已保存的阅读记录不会删除。",
      success: async (result) => {
        if (!result.confirm) return;
        await logout();
        this.setData({ loggedIn: false, user: null, items: [], reviews: [] });
      }
    });
  },

  changeTab(event) {
    const status = event.currentTarget.dataset.status || "";
    this.setData({ activeStatus: status }, () => this.refresh());
  },

  openWork(event) {
    const { slug } = event.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/work/work?slug=${encodeURIComponent(slug)}` });
  },

  goArchive() {
    wx.switchTab({ url: "/pages/archive/archive" });
  },

  openMyReview(event) {
    const { reviewId, status } = event.currentTarget.dataset;
    const review = this.data.reviews.find((item) => item.id === reviewId);
    if (!review) return;
    if (status === "PUBLISHED") {
      wx.navigateTo({
        url: `/pages/review-detail/review-detail?reviewId=${encodeURIComponent(reviewId)}`
      });
      return;
    }
    wx.showModal({
      title: review.statusLabel,
      content: review.body,
      showCancel: false,
      confirmText: "知道了"
    });
  },

  changeStatus(event) {
    const { workId } = event.currentTarget.dataset;
    const labels = ["想读", "在读", "已读", "暂停", "搁置"];
    const statuses = ["WISHLIST", "IN_PROGRESS", "COMPLETED", "PAUSED", "DROPPED"];
    wx.showActionSheet({
      itemList: labels,
      success: async (result) => {
        const status = statuses[result.tapIndex];
        if (!status) return;
        try {
          await updateShelfItem(workId, { status });
          await this.refresh();
        } catch (error) {
          wx.showToast({ title: error.message || "更新失败", icon: "none" });
        }
      }
    });
  }
});
