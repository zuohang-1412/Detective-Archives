import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve("apps/miniprogram");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setDataValue(target, key, value) {
  const parts = key.match(/[^.[\]]+/g) || [];
  let current = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      current[part] = value;
      return;
    }
    const nextPart = parts[index + 1];
    if (current[part] === undefined || current[part] === null) {
      current[part] = /^\d+$/.test(nextPart) ? [] : {};
    }
    current = current[part];
  });
}

function wxStub(overrides = {}) {
  return {
    navigateBack(options = {}) {
      options.success?.();
    },
    navigateTo() {},
    setNavigationBarTitle() {},
    showActionSheet() {},
    showModal() {},
    showToast() {},
    stopPullDownRefresh() {},
    switchTab() {},
    ...overrides
  };
}

async function loadPage(pageName, api, wxOverrides = {}) {
  const source = await readFile(path.join(root, `pages/${pageName}/${pageName}.js`), "utf8");
  let definition;
  vm.runInNewContext(source, {
    Page(pageDefinition) {
      definition = pageDefinition;
    },
    require(request) {
      if (request === "../../services/api") return api;
      throw new Error(`Unexpected require from ${pageName}: ${request}`);
    },
    wx: wxStub(wxOverrides)
  }, { filename: `${pageName}.js` });
  assert.ok(definition, `${pageName} must register a Page`);
  const instance = {
    ...definition,
    data: clone(definition.data),
    setData(values, callback) {
      Object.entries(values).forEach(([key, value]) => setDataValue(this.data, key, value));
      callback?.();
    }
  };
  return instance;
}

async function assertRequestFailureMessage(errMsg, expected) {
  const source = await readFile(path.join(root, "services/api.js"), "utf8");
  const module = { exports: {} };
  vm.runInNewContext(source, {
    getApp: () => ({ globalData: { apiBaseUrl: "https://api.example.test" } }),
    module,
    exports: module.exports,
    wx: {
      getStorageSync: () => "",
      removeStorageSync() {},
      request(options) {
        options.fail({ errMsg });
      },
      setStorageSync() {}
    }
  }, { filename: "services/api.js" });
  await assert.rejects(module.exports.listDetectives(), (error) => {
    assert.equal(error.message, expected);
    return true;
  });
}

async function assertHttpErrorMessage(statusCode, responseData, expected) {
  const source = await readFile(path.join(root, "services/api.js"), "utf8");
  const module = { exports: {} };
  vm.runInNewContext(source, {
    getApp: () => ({ globalData: { apiBaseUrl: "https://api.example.test" } }),
    module,
    exports: module.exports,
    wx: {
      getStorageSync: () => "session-token",
      removeStorageSync() {},
      request(options) {
        options.success({ statusCode, data: responseData });
      },
      setStorageSync() {}
    }
  }, { filename: "services/api.js" });
  await assert.rejects(module.exports.listDetectives(), (error) => {
    assert.equal(error.message, expected);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, responseData.code);
    return true;
  });
}

async function assertAccountDataDownload() {
  const source = await readFile(path.join(root, "services/api.js"), "utf8");
  const module = { exports: {} };
  let downloadOptions;
  vm.runInNewContext(source, {
    getApp: () => ({ globalData: { apiBaseUrl: "https://api.example.test" } }),
    module,
    exports: module.exports,
    wx: {
      downloadFile(options) {
        downloadOptions = options;
        options.success({ statusCode: 200, tempFilePath: "wxfile://private-export.json" });
      },
      getStorageSync: () => "session-token",
      removeStorageSync() {},
      setStorageSync() {}
    }
  }, { filename: "services/api.js" });
  const exported = await module.exports.downloadAccountData();
  assert.equal(downloadOptions.url, "https://api.example.test/api/v1/me/data-export");
  assert.equal(downloadOptions.header.authorization, "Bearer session-token");
  assert.equal(exported.tempFilePath, "wxfile://private-export.json");
  assert.match(exported.fileName, /^侦探档案馆-个人数据-\d{4}-\d{2}-\d{2}\.json$/);
}

await assertRequestFailureMessage(
  "request:fail timeout",
  "请求超时，请检查网络后重试"
);
await assertRequestFailureMessage(
  "request:fail connection reset",
  "网络连接失败，请检查网络后重试"
);
await assertHttpErrorMessage(
  403,
  { code: "ACCESS_DENIED", message: "你没有权限查看这项内容" },
  "你没有权限查看这项内容"
);
await assertHttpErrorMessage(
  404,
  { code: "CONTENT_NOT_FOUND", message: "内容已删除或不再公开" },
  "内容已删除或不再公开"
);
await assertAccountDataDownload();

let homeFails = true;
const home = await loadPage("home", {
  async listDetectives() {
    if (homeFails) throw new Error("首页网络失败");
    return { data: [{ id: "detective-1", slug: "detective-1" }] };
  }
});
await home.loadFeatured();
assert.equal(home.data.loading, false);
assert.equal(home.data.error, "首页网络失败");
homeFails = false;
await home.loadFeatured();
assert.equal(home.data.error, "");
assert.equal(home.data.detectives.length, 1);

let archiveFails = true;
const archive = await loadPage("archive", {
  async listDetectives() {
    if (archiveFails) throw new Error("目录网络失败");
    return {
      data: [],
      facets: { countries: [], eras: [], categories: [], subjectKinds: [], tags: [] },
      pagination: { page: 1, total: 0, totalPages: 1 }
    };
  },
  async listPictureBookEntries() {
    return { data: [], coverage: { latestPublishedVolume: 108, entryCount: 109 } };
  },
  async listArchiveDirectory() {
    return { data: [], coverage: { extensionCount: 38, historicalCount: 3 } };
  }
});
archive.searchRequestId = 0;
await archive.search();
assert.equal(archive.data.loading, false);
assert.equal(archive.data.error, "目录网络失败");
archiveFails = false;
await archive.retrySearch();
assert.equal(archive.data.error, "");
assert.equal(archive.data.coverage.total, 0);

let communityFails = true;
const community = await loadPage("community", {
  async listCommunityReviews() {
    if (communityFails) throw new Error("社区动态网络失败");
    return {
      data: [{
        id: "review-community-1",
        body: "公开评价",
        containsSpoiler: false,
        reviewType: "SHORT",
        author: { displayName: "测试读者" },
        work: { slug: "work-1", titleZh: "测试作品" },
        likeCount: 0,
        commentCount: 0,
        createdAt: "2026-07-22T00:00:00.000Z"
      }],
      pagination: { page: 1, totalPages: 1 }
    };
  }
});
community.feedRequestId = 0;
await community.loadFeed();
assert.equal(community.data.loading, false);
assert.equal(community.data.error, "社区动态网络失败");
communityFails = false;
await community.retryFeed();
assert.equal(community.data.error, "");
assert.equal(community.data.reviews.length, 1);
assert.equal(community.data.reviews[0].authorInitial, "测");

let detectiveFails = true;
const detective = await loadPage("detective", {
  async getDetective() {
    if (detectiveFails) throw new Error("人物档案网络失败");
    return { data: { id: "detective-1", nameZh: "测试侦探", works: [] } };
  }
});
detective.setData({ slug: "detective-1" });
await detective.loadDetective();
assert.equal(detective.data.error, "人物档案网络失败");
detectiveFails = false;
await detective.retryLoad();
assert.equal(detective.data.error, "");
assert.equal(detective.data.detective.nameZh, "测试侦探");

let workFails = true;
let reviewsFail = true;
const work = await loadPage("work", {
  async createWorkLinkFeedback() {},
  async getShelfItem() {},
  async getWork() {
    if (workFails) throw new Error("作品网络失败");
    return {
      data: {
        id: "work-1",
        slug: "work-1",
        titleZh: "测试作品",
        type: "NOVEL",
        links: [],
        creators: [],
        detectives: []
      }
    };
  },
  hasAuthToken: () => false,
  async listReviews() {
    if (reviewsFail) throw new Error("评价网络失败");
    return { data: [], pagination: { page: 1, totalPages: 1 } };
  },
  async removeShelfItem() {},
  async trackWorkLinkClick() {},
  async updateShelfItem() {}
});
work.setData({ slug: "work-1" });
await work.loadWork();
assert.equal(work.data.error, "作品网络失败");
workFails = false;
await work.loadWork();
assert.equal(work.data.error, "");
assert.equal(work.data.work.titleZh, "测试作品");
assert.equal(work.data.reviewsError, "评价网络失败");
reviewsFail = false;
await work.retryReviews();
assert.equal(work.data.reviewsError, "");
assert.equal(work.data.reviews.length, 0);

let meFails = true;
const me = await loadPage("me", {
  async deactivateAccount() {},
  async deleteReview() {},
  async getCurrentUser() {
    if (meFails) throw new Error("私人档案网络失败");
    return { data: { id: "user-1", displayName: "测试读者" } };
  },
  hasAuthToken: () => true,
  async listMyReviews() {
    return { data: [] };
  },
  async listShelf() {
    return { data: [] };
  },
  async loginWechat() {},
  async logout() {},
  async removeShelfItem() {},
  async updateShelfItem() {}
});
await me.refresh();
assert.equal(me.data.loading, false);
assert.equal(me.data.loadError, "私人档案网络失败");
meFails = false;
await me.refresh();
assert.equal(me.data.loadError, "");
assert.equal(me.data.loggedIn, true);

let suspendedShelfReads = 0;
const suspendedMe = await loadPage("me", {
  async deactivateAccount() {},
  async deleteReview() {},
  async downloadAccountData() {},
  async getCurrentUser() {
    return {
      data: {
        id: "user-suspended",
        displayName: "受限读者",
        isSuspended: true,
        suspendedUntil: "2026-07-23T08:30:00.000Z"
      }
    };
  },
  hasAuthToken: () => true,
  async listMyReviews() { throw new Error("suspended reviews must not load"); },
  async listShelf() { suspendedShelfReads += 1; },
  async logout() {}
});
await suspendedMe.refresh();
assert.equal(suspendedMe.data.loggedIn, true);
assert.equal(suspendedMe.data.user.isSuspended, true);
  assert.equal(suspendedShelfReads, 0);
  assert.match(suspendedMe.data.restrictedUntilLabel, /^2026-07-23 /);

  let agreementsCurrent = false;
  let agreementAcceptCount = 0;
  let agreementProtectedReads = 0;
  const agreementMe = await loadPage("me", {
    async acceptCurrentAgreements() {
      agreementAcceptCount += 1;
      agreementsCurrent = true;
    },
    async getCurrentUser() {
      return {
        data: {
          id: "user-agreement-update",
          displayName: "协议更新读者",
          agreementsCurrent
        }
      };
    },
    hasAuthToken: () => true,
    async listMyReviews() {
      agreementProtectedReads += 1;
      return { data: [] };
    },
    async listShelf() {
      agreementProtectedReads += 1;
      return { data: [] };
    }
  }, {
    getPrivacySetting(options) {
      options.success({ needAuthorization: false });
    }
  });
  await agreementMe.refresh();
  assert.equal(agreementMe.data.agreementReconsentRequired, true);
  assert.equal(agreementProtectedReads, 0);
  await agreementMe.confirmAgreementUpdate();
  assert.equal(agreementAcceptCount, 0);
  assert.equal(agreementMe.data.error, "请先阅读并同意更新后的用户协议和隐私政策");
  agreementMe.setData({ agreementsAccepted: true });
  await agreementMe.confirmAgreementUpdate();
  assert.equal(agreementAcceptCount, 1);
  assert.equal(agreementMe.data.agreementReconsentRequired, false);
  assert.equal(agreementProtectedReads, 2);
  assert.equal(agreementMe.data.acceptingAgreements, false);

  let sharedExport;
const exportMe = await loadPage("me", {
  async downloadAccountData() {
    return {
      tempFilePath: "wxfile://private-export.json",
      fileName: "侦探档案馆-个人数据-2026-07-22.json"
    };
  },
  hasAuthToken: () => true
}, {
  shareFileMessage(options) {
    sharedExport = options;
    options.success();
  }
});
await exportMe.exportMyData();
assert.equal(sharedExport.filePath, "wxfile://private-export.json");
assert.equal(sharedExport.fileName, "侦探档案馆-个人数据-2026-07-22.json");
assert.equal(exportMe.data.exportingData, false);

let privacyLoginCount = 0;
const privacyMe = await loadPage("me", {
  async deactivateAccount() {},
  async deleteReview() {},
  async getCurrentUser() {},
  hasAuthToken: () => false,
  async listMyReviews() { return { data: [] }; },
  async listShelf() { return { data: [] }; },
  async loginWechat() { privacyLoginCount += 1; },
  async logout() {},
  async removeShelfItem() {},
  async updateShelfItem() {}
}, {
  getPrivacySetting(options) {
    options.success({
      needAuthorization: true,
      privacyContractName: "《侦探档案馆小程序隐私保护指引》"
    });
  },
  openPrivacyContract(options) {
    options.success?.();
  }
});
assert.equal(await privacyMe.checkPlatformPrivacy(), true);
assert.equal(privacyMe.data.platformPrivacyRequired, true);
assert.equal(privacyMe.data.platformPrivacyContractName, "《侦探档案馆小程序隐私保护指引》");
await privacyMe.handleAgreePrivacyAuthorization();
assert.equal(privacyLoginCount, 0);
assert.equal(privacyMe.data.error, "请继续阅读并同意用户协议和隐私政策");
privacyMe.setData({ agreementsAccepted: true });
await privacyMe.handleAgreePrivacyAuthorization();
assert.equal(privacyLoginCount, 1);
assert.equal(privacyMe.data.loggingIn, false);

let privacyCheckFails = true;
const privacyFailureMe = await loadPage("me", {
  hasAuthToken: () => false
}, {
  getPrivacySetting(options) {
    if (privacyCheckFails) options.fail();
    else options.success({ needAuthorization: false });
  }
});
assert.equal(await privacyFailureMe.checkPlatformPrivacy(), true);
assert.equal(privacyFailureMe.data.platformPrivacyRequired, true);
assert.equal(privacyFailureMe.data.error, "暂时无法读取微信隐私授权状态，请稍后重试");
privacyCheckFails = false;
assert.equal(await privacyFailureMe.checkPlatformPrivacy(), false);
assert.equal(privacyFailureMe.data.platformPrivacyRequired, false);
assert.equal(privacyFailureMe.data.error, "");

let detailFails = true;
let reviewNavigationTitle = "";
const reviewDetail = await loadPage("review-detail", {
  async createComment() {},
  async createReport() {},
  async deleteComment() {},
  async deleteReview() {},
  async getCurrentUser() {},
  async getReview() {
    if (detailFails) throw new Error("评价详情网络失败");
    return {
      data: {
        id: "review-1",
        title: "从红发会看福尔摩斯的推理节奏",
        author: { id: "user-2", displayName: "其他读者" },
        work: { titleZh: "福尔摩斯探案集" },
        comments: [],
        containsSpoiler: false,
        commentPagination: { page: 1, totalPages: 1 }
      }
    };
  },
  hasAuthToken: () => false,
  async setCommentLike() {},
  async setReviewLike() {}
}, {
  setNavigationBarTitle(options) {
    reviewNavigationTitle = options.title;
  }
});
reviewDetail.setData({ reviewId: "review-1" });
await reviewDetail.loadReview();
assert.equal(reviewDetail.data.error, "评价详情网络失败");
assert.equal(reviewDetail.data.review, null);
detailFails = false;
await reviewDetail.loadReview();
assert.equal(reviewDetail.data.error, "");
assert.equal(reviewDetail.data.review.id, "review-1");
assert.equal(reviewNavigationTitle, "从红发会看福尔摩斯的推理节奏");
const reviewShare = reviewDetail.onShareAppMessage();
assert.equal(reviewShare.title, "从红发会看福尔摩斯的推理节奏｜侦探档案馆");
assert.equal(reviewShare.path, "/pages/review-detail/review-detail?reviewId=review-1");

let editorFails = true;
const reviewEditor = await loadPage("review-editor", {
  async createReview() {},
  async getMyReview() {
    if (editorFails) throw new Error("评价编辑网络失败");
    return {
      data: {
        id: "review-1",
        workId: "work-1",
        work: { titleZh: "测试作品" },
        reviewType: "SHORT",
        title: null,
        body: "测试正文",
        rating: null,
        containsSpoiler: false
      }
    };
  },
  async updateReview() {}
});
reviewEditor.setData({ reviewId: "review-1", editing: true });
await reviewEditor.loadReview();
assert.equal(reviewEditor.data.loading, false);
assert.equal(reviewEditor.data.loadError, "评价编辑网络失败");
editorFails = false;
await reviewEditor.retryLoad();
assert.equal(reviewEditor.data.loadError, "");
assert.equal(reviewEditor.data.body, "测试正文");

const retryBindings = [
  ["home", "loadFeatured", "轻触重试"],
  ["archive", "retrySearch", "重新检索"],
  ["community", "retryFeed", "重新读取动态"],
  ["detective", "retryLoad", "重新读取"],
  ["work", "loadWork", "重新读取"],
  ["work", "retryReviews", "重新读取评价"],
  ["me", "refresh", "重新读取"],
  ["review-detail", "loadReview", "重新读取"],
  ["review-editor", "retryLoad", "重新读取"]
];
for (const [pageName, method, label] of retryBindings) {
  const template = await readFile(path.join(root, `pages/${pageName}/${pageName}.wxml`), "utf8");
  assert.ok(template.includes(`bindtap="${method}"`), `${pageName} must bind ${method}`);
  assert.ok(template.includes(label), `${pageName} must explain the retry action`);
}

console.log("Mini program resilience: OK (network messages, failure states and retries)");
