const {
  createComment,
  createReport,
  deleteComment,
  deleteReview,
  getCurrentUser,
  getReview,
  hasAuthToken,
  setCommentLike,
  setReviewLike
} = require("../../services/api");

const reportReasons = [
  { label: "广告或垃圾信息", code: "SPAM" },
  { label: "辱骂或骚扰", code: "ABUSE" },
  { label: "仇恨或歧视", code: "HATE" },
  { label: "未标记的剧透", code: "SPOILER" },
  { label: "违法违规内容", code: "ILLEGAL" },
  { label: "版权问题", code: "COPYRIGHT" },
  { label: "其他问题", code: "OTHER" }
];

Page({
  data: {
    reviewId: "",
    review: null,
    loading: true,
    error: "",
    spoilerRevealed: false,
    commentBody: "",
    commentSpoiler: false,
    replyTo: null,
    viewerId: "",
    actionId: "",
    reportOpen: false,
    reportTargetType: "",
    reportTargetId: "",
    reportReasonCode: "",
    reportDescription: "",
    reportReasons,
    reportSubmitting: false,
    commentPage: 1,
    commentsHasMore: false,
    commentsLoading: false,
    submitting: false
  },

  onLoad(options) {
    if (!options.reviewId) {
      this.setData({ loading: false, error: "缺少评价编号" });
      return;
    }
    this.setData({ reviewId: options.reviewId });
    this.loadReview();
  },

  onShow() {
    if (this.data.reviewId && !this.data.loading) this.loadReview();
  },

  onPullDownRefresh() {
    this.loadReview().finally(() => wx.stopPullDownRefresh());
  },

  async loadReview() {
    this.setData({ loading: true, error: "" });
    try {
      const response = await getReview(this.data.reviewId, {
        commentPage: 1,
        commentPageSize: 20
      });
      let viewerId = "";
      if (hasAuthToken()) {
        try {
          const viewerResponse = await getCurrentUser();
          viewerId = viewerResponse.data.id;
        } catch (_error) {
          viewerId = "";
        }
      }
      const review = {
        ...response.data,
        isMine: response.data.author.id === viewerId,
        comments: response.data.comments.map((comment) => ({
          ...comment,
          isMine: comment.author.id === viewerId,
          spoilerRevealed: !comment.containsSpoiler
        }))
      };
      this.setData({
        review,
        spoilerRevealed: !review.containsSpoiler,
        viewerId,
        commentPage: 1,
        commentsHasMore: response.data.commentPagination.page < response.data.commentPagination.totalPages
      });
    } catch (error) {
      this.setData({ error: error.message || "评价读取失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadMoreComments() {
    if (!this.data.review || !this.data.commentsHasMore || this.data.commentsLoading) return;
    const nextPage = this.data.commentPage + 1;
    this.setData({ commentsLoading: true });
    try {
      const response = await getReview(this.data.reviewId, {
        commentPage: nextPage,
        commentPageSize: 20
      });
      const existing = new Set(this.data.review.comments.map((comment) => comment.id));
      const comments = response.data.comments
        .filter((comment) => !existing.has(comment.id))
        .map((comment) => ({
          ...comment,
          isMine: comment.author.id === this.data.viewerId,
          spoilerRevealed: !comment.containsSpoiler
        }));
      this.setData({
        "review.comments": [...this.data.review.comments, ...comments],
        commentPage: nextPage,
        commentsHasMore: nextPage < response.data.commentPagination.totalPages
      });
    } catch (error) {
      wx.showToast({ title: error.message || "更多回复读取失败", icon: "none" });
    } finally {
      this.setData({ commentsLoading: false });
    }
  },

  requireLogin() {
    if (hasAuthToken()) return true;
    wx.showModal({
      title: "登录后参与讨论",
      content: "前往“我的档案馆”完成微信登录。",
      confirmText: "去登录",
      success: (result) => {
        if (result.confirm) wx.switchTab({ url: "/pages/me/me" });
      }
    });
    return false;
  },

  revealReview() {
    this.setData({ spoilerRevealed: true });
  },

  revealComment(event) {
    const { index } = event.currentTarget.dataset;
    this.setData({ [`review.comments[${index}].spoilerRevealed`]: true });
  },

  async toggleReviewLike() {
    if (!this.requireLogin() || !this.data.review) return;
    try {
      const response = await setReviewLike(this.data.review.id, !this.data.review.likedByMe);
      this.setData({
        "review.likedByMe": response.data.liked,
        "review.likeCount": response.data.likeCount
      });
    } catch (error) {
      wx.showToast({ title: error.message || "操作失败", icon: "none" });
    }
  },

  async toggleCommentLike(event) {
    if (!this.requireLogin()) return;
    const { index } = event.currentTarget.dataset;
    const comment = this.data.review.comments[index];
    if (!comment) return;
    try {
      const response = await setCommentLike(comment.id, !comment.likedByMe);
      this.setData({
        [`review.comments[${index}].likedByMe`]: response.data.liked,
        [`review.comments[${index}].likeCount`]: response.data.likeCount
      });
    } catch (error) {
      wx.showToast({ title: error.message || "操作失败", icon: "none" });
    }
  },

  inputComment(event) {
    this.setData({ commentBody: event.detail.value });
  },

  changeCommentSpoiler(event) {
    this.setData({ commentSpoiler: event.detail.value });
  },

  chooseReply(event) {
    const { commentId, author } = event.currentTarget.dataset;
    this.setData({ replyTo: { id: commentId, author } });
  },

  cancelReply() {
    this.setData({ replyTo: null });
  },

  async submitComment() {
    if (!this.requireLogin() || this.data.submitting) return;
    const body = this.data.commentBody.trim();
    if (!body) {
      wx.showToast({ title: "请先写下回复", icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    try {
      await createComment(this.data.reviewId, {
        ...(this.data.replyTo ? { parentId: this.data.replyTo.id } : {}),
        body,
        containsSpoiler: this.data.commentSpoiler
      });
      this.setData({ commentBody: "", commentSpoiler: false, replyTo: null });
      wx.showModal({
        title: "回复已提交",
        content: "审核通过后会显示在讨论中。",
        showCancel: false
      });
    } catch (error) {
      wx.showToast({ title: error.message || "回复失败", icon: "none" });
    } finally {
      this.setData({ submitting: false });
    }
  },

  reportReview() {
    if (this.data.review) this.openReport("REVIEW", this.data.review.id);
  },

  reportComment(event) {
    this.openReport("COMMENT", event.currentTarget.dataset.commentId);
  },

  editReview() {
    if (!this.data.review?.isMine) return;
    wx.navigateTo({
      url: `/pages/review-editor/review-editor?reviewId=${encodeURIComponent(this.data.review.id)}`
    });
  },

  deleteOwnReview() {
    if (!this.data.review?.isMine || this.data.actionId) return;
    wx.showModal({
      title: "删除评价",
      content: "确定删除这条评价吗？删除后其他读者将无法查看。",
      confirmText: "确认删除",
      confirmColor: "#9f3123",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ actionId: this.data.review.id });
        try {
          await deleteReview(this.data.review.id);
          wx.showToast({ title: "评价已删除", icon: "success" });
          wx.navigateBack();
        } catch (error) {
          wx.showToast({ title: error.message || "删除失败", icon: "none" });
        } finally {
          this.setData({ actionId: "" });
        }
      }
    });
  },

  deleteOwnComment(event) {
    const { commentId } = event.currentTarget.dataset;
    const comment = this.data.review?.comments.find((item) => item.id === commentId);
    if (!comment?.isMine || this.data.actionId) return;
    wx.showModal({
      title: "删除回复",
      content: "确定删除这条回复吗？",
      confirmText: "确认删除",
      confirmColor: "#9f3123",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ actionId: commentId });
        try {
          await deleteComment(commentId);
          await this.loadReview();
          wx.showToast({ title: "回复已删除", icon: "success" });
        } catch (error) {
          wx.showToast({ title: error.message || "删除失败", icon: "none" });
        } finally {
          this.setData({ actionId: "" });
        }
      }
    });
  },

  openReport(targetType, targetId) {
    if (!this.requireLogin()) return;
    this.setData({
      reportOpen: true,
      reportTargetType: targetType,
      reportTargetId: targetId,
      reportReasonCode: "",
      reportDescription: ""
    });
  },

  keepReportOpen() {},

  closeReport() {
    if (this.data.reportSubmitting) return;
    this.setData({
      reportOpen: false,
      reportTargetType: "",
      reportTargetId: "",
      reportReasonCode: "",
      reportDescription: ""
    });
  },

  selectReportReason(event) {
    this.setData({ reportReasonCode: event.currentTarget.dataset.code || "" });
  },

  inputReportDescription(event) {
    this.setData({ reportDescription: event.detail.value });
  },

  async submitReport() {
    if (this.data.reportSubmitting || !this.data.reportReasonCode) return;
    this.setData({ reportSubmitting: true });
    try {
      const description = this.data.reportDescription.trim();
      await createReport({
        targetType: this.data.reportTargetType,
        targetId: this.data.reportTargetId,
        reasonCode: this.data.reportReasonCode,
        ...(description ? { description } : {})
      });
      this.setData({
        reportOpen: false,
        reportTargetType: "",
        reportTargetId: "",
        reportReasonCode: "",
        reportDescription: ""
      });
      wx.showToast({ title: "举报已提交", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error.message || "举报失败", icon: "none" });
    } finally {
      this.setData({ reportSubmitting: false });
    }
  }
});
