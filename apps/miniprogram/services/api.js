function getBaseUrl() {
  const app = getApp();
  return app.globalData.apiBaseUrl;
}

function request(path, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${getBaseUrl()}${path}`,
      method: "GET",
      data,
      timeout: 8000,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        reject(new Error(response.data?.message || "档案读取失败"));
      },
      fail(error) {
        reject(new Error(error.errMsg || "网络连接失败"));
      }
    });
  });
}

function listDetectives(params = {}) {
  return request("/api/v1/detectives", params);
}

function getDetective(slug) {
  return request(`/api/v1/detectives/${encodeURIComponent(slug)}`);
}

function listWorks(params = {}) {
  return request("/api/v1/works", params);
}

function getWork(slug) {
  return request(`/api/v1/works/${encodeURIComponent(slug)}`);
}

function listPictureBookEntries(params = {}) {
  return request("/api/v1/picture-book", params);
}

function listArchiveDirectory(params = {}) {
  return request("/api/v1/archive-directory", params);
}

module.exports = {
  getDetective,
  getWork,
  listArchiveDirectory,
  listDetectives,
  listPictureBookEntries,
  listWorks
};
