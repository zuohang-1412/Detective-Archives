const { createReview, getMyReview, updateReview } = require("../../services/api");

Page({
  data: {
    workId: "",
    reviewId: "",
    workTitle: "",
    reviewType: "SHORT",
    title: "",
    body: "",
    ratingIndex: 0,
    ratingOptions: ["不评分", "1 分", "2 分", "3 分", "4 分", "5 分"],
    containsSpoiler: false,
    editing: false,
    loading: false,
    submitting: false,
    error: ""
  },

  onLoad(options) {
    if (options.reviewId) {
      this.setData({ reviewId: options.reviewId, editing: true, loading: true });
      wx.setNavigationBarTitle({ title: "编辑评价" });
      this.loadReview();
      return;
    }
    if (!options.workId) {
      this.setData({ error: "缺少作品编号" });
      return;
    }
    this.setData({
      workId: options.workId,
      workTitle: options.title ? decodeURIComponent(options.title) : "这部作品"
    });
  },

  async loadReview() {
    try {
      const response = await getMyReview(this.data.reviewId);
      const review = response.data;
      this.setData({
        workId: review.workId,
        workTitle: review.work.titleZh,
        reviewType: review.reviewType,
        title: review.title || "",
        body: review.body,
        ratingIndex: Number(review.rating || 0),
        containsSpoiler: review.containsSpoiler
      });
    } catch (error) {
      this.setData({ error: error.message || "评价读取失败" });
    } finally {
      this.setData({ loading: false });
    }
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
    if (this.data.loading || this.data.submitting) return;
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
      const payload = {
        reviewType: this.data.reviewType,
        ...(this.data.reviewType === "LONG" && title ? { title } : {}),
        body,
        ...(this.data.ratingIndex ? { rating: this.data.ratingIndex } : {}),
        containsSpoiler: this.data.containsSpoiler
      };
      if (this.data.editing) {
        await updateReview(this.data.reviewId, payload);
      } else {
        await createReview(this.data.workId, payload);
      }
      wx.showModal({
        title: this.data.editing ? "修改已提交" : "已提交审核",
        content: this.data.editing
          ? "修改后的评价会重新进入审核，通过后再次公开。"
          : "评价会在审核通过后公开。你可以在“我的档案馆”查看审核状态。",
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
