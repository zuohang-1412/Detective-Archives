const { listCommunityReviews } = require("../../services/api");

function formatPublishedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  const part = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function bodyPreview(body) {
  const normalized = String(body || "").replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 180)}…` : normalized;
}

Page({
  data: {
    filters: [
      { value: "", label: "全部" },
      { value: "SHORT", label: "短评" },
      { value: "LONG", label: "长评" }
    ],
    activeReviewType: "",
    reviews: [],
    page: 1,
    hasMore: false,
    loading: true,
    loadingMore: false,
    error: ""
  },

  onLoad() {
    this.feedRequestId = 0;
    this.loadFeed();
  },

  onPullDownRefresh() {
    this.loadFeed().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  selectReviewType(event) {
    const reviewType = event.currentTarget.dataset.reviewType || "";
    if (reviewType === this.data.activeReviewType || this.data.loading) return;
    this.setData({
      activeReviewType: reviewType,
      reviews: [],
      page: 1,
      hasMore: false,
      loadingMore: false,
      error: ""
    }, () => this.loadFeed());
  },

  async loadFeed(options = {}) {
    const append = Boolean(options.append);
    const requestId = ++this.feedRequestId;
    const page = append ? this.data.page + 1 : 1;
    this.setData(append
      ? { loadingMore: true }
      : { loading: true, loadingMore: false, error: "" });
    try {
      const response = await listCommunityReviews({
        page,
        pageSize: 10,
        ...(this.data.activeReviewType ? { reviewType: this.data.activeReviewType } : {})
      });
      if (requestId !== this.feedRequestId) return;
      const reviews = response.data.map((review) => ({
        ...review,
        authorInitial: String(review.author?.displayName || "读").slice(0, 1),
        bodyPreview: bodyPreview(review.body),
        publishedAtLabel: formatPublishedAt(review.publishedAt || review.createdAt),
        reviewTypeLabel: review.reviewType === "LONG" ? "长评" : "短评",
        spoilerRevealed: !review.containsSpoiler
      }));
      this.setData({
        reviews: append ? [...this.data.reviews, ...reviews] : reviews,
        page,
        hasMore: page < response.pagination.totalPages,
        error: ""
      });
    } catch (error) {
      if (requestId !== this.feedRequestId) return;
      if (append) {
        wx.showToast({ title: "更多动态读取失败", icon: "none" });
      } else {
        this.setData({
          reviews: [],
          hasMore: false,
          error: error.message || "社区动态读取失败，请稍后重试"
        });
      }
    } finally {
      if (requestId === this.feedRequestId) {
        this.setData(append ? { loadingMore: false } : { loading: false });
      }
    }
  },

  retryFeed() {
    if (this.data.loading) return Promise.resolve();
    return this.loadFeed();
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return;
    this.loadFeed({ append: true });
  },

  revealSpoiler(event) {
    const index = Number.parseInt(event.currentTarget.dataset.index, 10);
    if (!Number.isInteger(index)) return;
    this.setData({ [`reviews[${index}].spoilerRevealed`]: true });
  },

  openReview(event) {
    const reviewId = event.currentTarget.dataset.reviewId;
    if (!reviewId) return;
    wx.navigateTo({
      url: `/pages/review-detail/review-detail?reviewId=${encodeURIComponent(reviewId)}`
    });
  },

  openWork(event) {
    const slug = event.currentTarget.dataset.slug;
    if (!slug) return;
    wx.navigateTo({ url: `/pages/work/work?slug=${encodeURIComponent(slug)}` });
  },

  goToArchive() {
    wx.switchTab({ url: "/pages/archive/archive" });
  }
});
