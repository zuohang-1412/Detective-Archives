const { createReview } = require("../../services/api");

Page({
  data: {
    workId: "",
    workTitle: "",
    reviewType: "SHORT",
    title: "",
    body: "",
    ratingIndex: 0,
    ratingOptions: ["不评分", "1 分", "2 分", "3 分", "4 分", "5 分"],
    containsSpoiler: false,
    submitting: false,
    error: ""
  },

  onLoad(options) {
    if (!options.workId) {
      this.setData({ error: "缺少作品编号" });
      return;
    }
    this.setData({
      workId: options.workId,
      workTitle: options.title ? decodeURIComponent(options.title) : "这部作品"
    });
  },

  changeType(event) {
    this.setData({ reviewType: event.currentTarget.dataset.type });
  },

  inputTitle(event) {
    this.setData({ title: event.detail.value });
  },

  inputBody(event) {
    this.setData({ body: event.detail.value });
  },

  changeRating(event) {
    this.setData({ ratingIndex: Number(event.detail.value) });
  },

  changeSpoiler(event) {
    this.setData({ containsSpoiler: event.detail.value });
  },

  async submit() {
    if (this.data.submitting) return;
    const body = this.data.body.trim();
    const title = this.data.title.trim();
    if (body.length < 2) {
      this.setData({ error: "请至少写下两个字的阅读感受" });
      return;
    }
    if (this.data.reviewType === "LONG" && !title) {
      this.setData({ error: "长评需要填写标题" });
      return;
    }
    this.setData({ submitting: true, error: "" });
    try {
      await createReview(this.data.workId, {
        reviewType: this.data.reviewType,
        ...(title ? { title } : {}),
        body,
        ...(this.data.ratingIndex ? { rating: this.data.ratingIndex } : {}),
        containsSpoiler: this.data.containsSpoiler
      });
      wx.showModal({
        title: "已提交审核",
        content: "评价会在审核通过后公开。你可以在“我的档案馆”查看审核状态。",
        showCancel: false,
        success: () => wx.navigateBack()
      });
    } catch (error) {
      this.setData({ error: error.message || "提交失败，请稍后再试" });
    } finally {
      this.setData({ submitting: false });
    }
  }
});
