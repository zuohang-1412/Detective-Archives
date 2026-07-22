const {
  createAppeal,
  deactivateAccount,
  deleteReview,
  downloadAccountData,
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

function formatRestrictedUntil(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const part = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

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
    platformPrivacyRequired: false,
    platformPrivacyContractName: "《小程序用户隐私保护指引》",
    shelfActionId: "",
    reviewActionId: "",
    appealActionId: "",
    exportingData: false,
    restrictedUntilLabel: "",
    loadError: "",
    error: ""
  },

  onShow() {
    if (!hasAuthToken()) this.checkPlatformPrivacy();
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    if (!hasAuthToken()) {
      this.setData({
        loggedIn: false,
        user: null,
        items: [],
        reviews: [],
        loading: false,
        loadError: ""
      });
      return;
    }
    this.setData({ loading: true, loadError: "", error: "" });
    try {
      const userResponse = await getCurrentUser();
      if (userResponse.data.isSuspended) {
        this.setData({
          loggedIn: true,
          user: userResponse.data,
          items: [],
          reviews: [],
          restrictedUntilLabel: formatRestrictedUntil(userResponse.data.suspendedUntil),
          loadError: ""
        });
        return;
      }
      const [shelfResponse, reviewResponse] = await Promise.all([
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
        statusLabel: reviewStatusLabels[review.status] || review.status,
        canAppeal: review.status === "HIDDEN" && review.appeal?.status !== "OPEN",
        appealStatusLabel: {
          OPEN: "申诉处理中",
          APPROVED: "申诉通过，内容已恢复",
          REJECTED: "申诉未通过",
          CANCELLED: "申诉已取消"
        }[review.appeal?.status] || ""
      }));
      this.setData({ loggedIn: true, user: userResponse.data, items, reviews, loadError: "" });
    } catch (error) {
      this.setData({
        loggedIn: hasAuthToken(),
        loadError: error.message || "档案馆读取失败，请稍后重试"
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async checkPlatformPrivacy() {
    if (typeof wx.getPrivacySetting !== "function") {
      this.setData({ platformPrivacyRequired: false });
      return false;
    }
    return new Promise((resolve) => {
      wx.getPrivacySetting({
        success: (result) => {
          const required = result.needAuthorization === true;
          const updates = {
            platformPrivacyRequired: required,
            platformPrivacyContractName: result.privacyContractName || "《小程序用户隐私保护指引》"
          };
          if (this.data.error === "暂时无法读取微信隐私授权状态，请稍后重试") {
            updates.error = "";
          }
          this.setData(updates);
          resolve(required);
        },
        fail: () => {
          this.setData({
            platformPrivacyRequired: true,
            error: "暂时无法读取微信隐私授权状态，请稍后重试"
          });
          resolve(true);
        }
      });
    });
  },

  openPlatformPrivacy() {
    if (typeof wx.openPrivacyContract !== "function") {
      wx.showToast({ title: "当前微信版本暂不支持打开隐私指引", icon: "none" });
      return;
    }
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: "隐私指引打开失败，请稍后重试", icon: "none" })
    });
  },

  async login() {
    if (this.data.loggingIn) return;
    if (!this.data.agreementsAccepted) {
      this.setData({ error: "请先阅读并同意用户协议和隐私政策" });
      return;
    }
    const platformPrivacyRequired = await this.checkPlatformPrivacy();
    if (platformPrivacyRequired) {
      this.setData({ error: "请先阅读并同意微信平台的隐私保护指引" });
      return;
    }
    await this.performLogin();
  },

  async handleAgreePrivacyAuthorization() {
    this.setData({ platformPrivacyRequired: false, error: "" });
    if (!this.data.agreementsAccepted) {
      this.setData({ error: "请继续阅读并同意用户协议和隐私政策" });
      return;
    }
    await this.performLogin();
  },

  async performLogin() {
    if (this.data.loggingIn) return;
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

  requestDataExport() {
    if (this.data.exportingData) return;
    wx.showModal({
      title: "导出个人数据",
      content: "导出文件包含账号资料、微信身份标识、书架、评价、回复和互动记录。请只发送到你信任的位置，并妥善保存。",
      confirmText: "生成文件",
      success: (result) => {
        if (result.confirm) this.exportMyData();
      }
    });
  },

  async exportMyData() {
    if (this.data.exportingData) return;
    if (typeof wx.shareFileMessage !== "function") {
      wx.showToast({ title: "当前微信版本不支持导出文件", icon: "none" });
      return;
    }
    this.setData({ exportingData: true });
    try {
      const exported = await downloadAccountData();
      await new Promise((resolve, reject) => {
        wx.shareFileMessage({
          filePath: exported.tempFilePath,
          fileName: exported.fileName,
          success: resolve,
          fail: reject
        });
      });
      wx.showToast({ title: "导出文件已生成", icon: "success" });
    } catch (error) {
      if (!/cancel/i.test(error?.errMsg || "")) {
        wx.showToast({ title: error.message || "个人数据导出失败", icon: "none" });
      }
    } finally {
      this.setData({ exportingData: false });
    }
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

  appealMyReview(event) {
    const { reviewId } = event.currentTarget.dataset;
    const review = this.data.reviews.find((item) => item.id === reviewId);
    if (!review || review.status !== "HIDDEN" || this.data.appealActionId) return;
    wx.showModal({
      title: "申请复核",
      content: "请说明你认为内容应恢复的原因。提交后，编辑或删除内容会自动取消本次申诉。",
      editable: true,
      placeholderText: "至少 5 个字，最多 500 个字",
      success: async (result) => {
        const reason = result.content?.trim() || "";
        if (!result.confirm) return;
        if (reason.length < 5) {
          wx.showToast({ title: "请至少填写 5 个字", icon: "none" });
          return;
        }
        this.setData({ appealActionId: reviewId });
        try {
          await createAppeal({ targetType: "REVIEW", targetId: reviewId, reason });
          await this.refresh();
          wx.showToast({ title: "申诉已提交", icon: "success" });
        } catch (error) {
          wx.showToast({ title: error.message || "申诉提交失败", icon: "none" });
        } finally {
          this.setData({ appealActionId: "" });
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
