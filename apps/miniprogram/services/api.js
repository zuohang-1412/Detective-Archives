function getBaseUrl() {
  const app = getApp();
  return app.globalData.apiBaseUrl;
}

const TOKEN_KEY = "detectiveArchivesToken";
const SESSION_EXPIRY_KEY = "detectiveArchivesSessionExpiry";

function clearSession() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(SESSION_EXPIRY_KEY);
}

function saveSession(session) {
  wx.setStorageSync(TOKEN_KEY, session.token);
  wx.setStorageSync(SESSION_EXPIRY_KEY, session.expiresAt);
}

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || "";
}

function hasAuthToken() {
  return Boolean(getToken());
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    wx.request({
      url: `${getBaseUrl()}${path}`,
      method: options.method || "GET",
      data: options.data,
      header: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      timeout: options.timeout || 8000,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        if (response.statusCode === 401) {
          clearSession();
        }
        const error = new Error(response.data?.message || "档案读取失败");
        error.code = response.data?.code;
        error.statusCode = response.statusCode;
        reject(error);
      },
      fail(error) {
        const message = /timeout/i.test(error.errMsg || "")
          ? "请求超时，请检查网络后重试"
          : "网络连接失败，请检查网络后重试";
        reject(new Error(message));
      }
    });
  });
}

async function listAllPages(path, data = {}) {
  const collected = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await request(path, {
      data: { ...data, page, pageSize: 50 }
    });
    collected.push(...response.data);
    const totalPages = response.pagination?.totalPages || 1;
    if (page >= totalPages) return { ...response, data: collected };
  }
  throw new Error("列表记录过多，请缩小筛选范围");
}

function listDetectives(params = {}) {
  return request("/api/v1/detectives", { data: params });
}

function getDetective(slug) {
  return request(`/api/v1/detectives/${encodeURIComponent(slug)}`);
}

function listWorks(params = {}) {
  return request("/api/v1/works", { data: params });
}

function getWork(slug) {
  return request(`/api/v1/works/${encodeURIComponent(slug)}`);
}

function trackWorkLinkClick(linkId) {
  return request(`/api/v1/work-links/${encodeURIComponent(linkId)}/click`, { method: "POST" });
}

function createWorkLinkFeedback(linkId, data) {
  return request(`/api/v1/work-links/${encodeURIComponent(linkId)}/feedback`, {
    method: "POST",
    data
  });
}

function listPictureBookEntries(params = {}) {
  return request("/api/v1/picture-book", { data: params });
}

function listArchiveDirectory(params = {}) {
  return request("/api/v1/archive-directory", { data: params });
}

function loginWechat(agreements) {
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: 8000,
      success: async (result) => {
        if (!result.code) {
          reject(new Error("微信未返回登录凭证"));
          return;
        }
        try {
          const response = await request("/api/v1/auth/wechat", {
            method: "POST",
            data: {
              code: result.code,
              agreements,
              profile: { displayName: "推理读者" }
            }
          });
          saveSession(response.data);
          resolve(response);
        } catch (error) {
          reject(error);
        }
      },
      fail: (error) => reject(new Error(error.errMsg || "微信登录失败"))
    });
  });
}

function getCurrentUser() {
  return request("/api/v1/auth/me");
}

async function refreshSession() {
  if (!hasAuthToken()) return null;
  const response = await request("/api/v1/auth/refresh", { method: "POST" });
  saveSession(response.data);
  return response;
}

async function logout() {
  try {
    await request("/api/v1/auth/logout", { method: "POST" });
  } finally {
    clearSession();
  }
}

function listShelf(status) {
  return listAllPages("/api/v1/me/shelf", status ? { status } : {});
}

function getShelfItem(workId) {
  return request(`/api/v1/me/shelf/${encodeURIComponent(workId)}`);
}

function updateShelfItem(workId, data) {
  return request(`/api/v1/me/shelf/${encodeURIComponent(workId)}`, {
    method: "PUT",
    data
  });
}

function removeShelfItem(workId) {
  return request(`/api/v1/me/shelf/${encodeURIComponent(workId)}`, {
    method: "DELETE"
  });
}

function listReviews(workId, params = {}) {
  return request(`/api/v1/works/${encodeURIComponent(workId)}/reviews`, { data: params });
}

function getReview(reviewId, params = {}) {
  return request(`/api/v1/reviews/${encodeURIComponent(reviewId)}`, { data: params });
}

function listMyReviews() {
  return listAllPages("/api/v1/me/reviews");
}

function getMyReview(reviewId) {
  return request(`/api/v1/me/reviews/${encodeURIComponent(reviewId)}`);
}

function createReview(workId, data) {
  return request(`/api/v1/works/${encodeURIComponent(workId)}/reviews`, {
    method: "POST",
    data,
    timeout: 20000
  });
}

function updateReview(reviewId, data) {
  return request(`/api/v1/reviews/${encodeURIComponent(reviewId)}`, {
    method: "PATCH",
    data,
    timeout: 20000
  });
}

function deleteReview(reviewId) {
  return request(`/api/v1/reviews/${encodeURIComponent(reviewId)}`, { method: "DELETE" });
}

function createComment(reviewId, data) {
  return request(`/api/v1/reviews/${encodeURIComponent(reviewId)}/comments`, {
    method: "POST",
    data,
    timeout: 20000
  });
}

function deleteComment(commentId) {
  return request(`/api/v1/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
}

function setReviewLike(reviewId, liked) {
  return request(`/api/v1/reviews/${encodeURIComponent(reviewId)}/like`, {
    method: liked ? "PUT" : "DELETE"
  });
}

function setCommentLike(commentId, liked) {
  return request(`/api/v1/comments/${encodeURIComponent(commentId)}/like`, {
    method: liked ? "PUT" : "DELETE"
  });
}

function createReport(data) {
  return request("/api/v1/reports", { method: "POST", data });
}

async function deactivateAccount() {
  try {
    await request("/api/v1/me/account", {
      method: "DELETE",
      data: { confirmation: "DELETE" }
    });
  } finally {
    clearSession();
  }
}

module.exports = {
  createComment,
  createWorkLinkFeedback,
  createReport,
  createReview,
  deactivateAccount,
  deleteComment,
  deleteReview,
  getCurrentUser,
  getDetective,
  getShelfItem,
  getMyReview,
  hasAuthToken,
  getWork,
  getReview,
  listArchiveDirectory,
  listDetectives,
  listPictureBookEntries,
  listMyReviews,
  listReviews,
  listShelf,
  listWorks,
  loginWechat,
  logout,
  refreshSession,
  removeShelfItem,
  setCommentLike,
  setReviewLike,
  trackWorkLinkClick,
  updateReview,
  updateShelfItem
};
