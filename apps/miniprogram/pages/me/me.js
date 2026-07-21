const {
  deactivateAccount,
  deleteReview,
  getCurrentUser,
  hasAuthToken,
  listMyReviews,
  listShelf,
  loginWechat,
  logout,
  removeShelfItem,
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
    agreementsAccepted: false,
    shelfActionId: "",
    reviewActionId: "",
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
    if (!this.data.agreementsAccepted) {
      this.setData({ error: "请先阅读并同意用户协议和隐私政策" });
      return;
    }
    this.setData({ loggingIn: true, error: "" });
    try {
      await loginWechat({ termsAccepted: true, privacyAccepted: true });
      await this.refresh();
      wx.showToast({ title: "登录成功", icon: "success" });
    } catch (error) {
      this.setData({ error: error.message || "登录失败" });
    } finally {
      this.setData({ loggingIn: false });
    }
  },

  toggleAgreements(event) {
    this.setData({ agreementsAccepted: event.detail.value.length > 0, error: "" });
  },

  openLegal(event) {
    const { type } = event.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/legal/legal?type=${type}` });
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

  confirmDeactivate() {
    wx.showModal({
      title: "注销账号",
      content: "注销后微信身份和会话将被移除，书架清空，你发布的评价与回复会被隐藏。该操作无法撤销。",
      confirmText: "继续注销",
      confirmColor: "#9f3123",
      success: (first) => {
        if (!first.confirm) return;
        wx.showModal({
          title: "再次确认",
          content: "确定永久注销当前账号吗？",
          confirmText: "确认注销",
          confirmColor: "#9f3123",
          success: async (second) => {
            if (!second.confirm) return;
            try {
              await deactivateAccount();
              this.setData({ loggedIn: false, user: null, items: [], reviews: [] });
              wx.showToast({ title: "账号已注销", icon: "none" });
            } catch (error) {
              wx.showToast({ title: error.message || "注销失败", icon: "none" });
            }
          }
        });
      }
    });
  },

  changeTab(event) {
    const status = event.currentTarget.dataset.status || "";
    this.setData({ activeStatus: status }, () => this.refresh());
  },

  openWork(event) {
    const { workId, slug } = event.currentTarget.dataset;
    const item = this.data.items.find((entry) => entry.workId === workId);
    if (item && !item.work.isAvailable) {
      wx.showModal({
        title: "作品资料暂不可用",
        content: "这条阅读记录会继续保留，你仍可以在此查看进度或将它移出档案馆。",
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }
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

  editMyReview(event) {
    const { reviewId } = event.currentTarget.dataset;
    if (!reviewId) return;
    wx.navigateTo({
      url: `/pages/review-editor/review-editor?reviewId=${encodeURIComponent(reviewId)}`
    });
  },

  deleteMyReview(event) {
    const { reviewId } = event.currentTarget.dataset;
    const review = this.data.reviews.find((item) => item.id === reviewId);
    if (!review || this.data.reviewActionId) return;
    wx.showModal({
      title: "删除评价",
      content: `确定删除《${review.work.titleZh}》下的这条评价吗？删除后其他读者将无法查看。`,
      confirmText: "确认删除",
      confirmColor: "#9f3123",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ reviewActionId: reviewId });
        try {
          await deleteReview(reviewId);
          await this.refresh();
          wx.showToast({ title: "评价已删除", icon: "success" });
        } catch (error) {
          wx.showToast({ title: error.message || "删除失败", icon: "none" });
        } finally {
          this.setData({ reviewActionId: "" });
        }
      }
    });
  },

  changeStatus(event) {
    const { workId } = event.currentTarget.dataset;
    const item = this.data.items.find((entry) => entry.workId === workId);
    if (item && !item.work.isAvailable) {
      wx.showToast({ title: "作品资料暂不可用", icon: "none" });
      return;
    }
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
  },

  removeUnavailableShelf(event) {
    const { workId } = event.currentTarget.dataset;
    const item = this.data.items.find((entry) => entry.workId === workId);
    if (!item || item.work.isAvailable || this.data.shelfActionId) return;
    wx.showModal({
      title: "移出档案馆",
      content: `确定移除《${item.work.titleZh}》的阅读记录吗？`,
      confirmText: "确认移除",
      confirmColor: "#9f3123",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ shelfActionId: workId });
        try {
          await removeShelfItem(workId);
          await this.refresh();
          wx.showToast({ title: "已移出档案馆", icon: "none" });
        } catch (error) {
          wx.showToast({ title: error.message || "移除失败", icon: "none" });
        } finally {
          this.setData({ shelfActionId: "" });
        }
      }
    });
  }
});
