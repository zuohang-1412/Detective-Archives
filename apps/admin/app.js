const tokenKey = "detectiveArchivesAdminToken";

const elements = {
  loginPanel: document.querySelector("#loginPanel"),
  loginForm: document.querySelector("#loginForm"),
  loginId: document.querySelector("#loginId"),
  password: document.querySelector("#password"),
  loginError: document.querySelector("#loginError"),
  workspace: document.querySelector("#workspace"),
  workspaceError: document.querySelector("#workspaceError"),
  logoutButton: document.querySelector("#logoutButton"),
  refreshButton: document.querySelector("#refreshButton"),
  metrics: document.querySelector("#metrics"),
  analyticsMetrics: document.querySelector("#analyticsMetrics"),
  analyticsPeriod: document.querySelector("#analyticsPeriod"),
  reviewQueue: document.querySelector("#reviewQueue"),
  commentQueue: document.querySelector("#commentQueue"),
  reportQueue: document.querySelector("#reportQueue"),
  appealQueue: document.querySelector("#appealQueue"),
  reviewCount: document.querySelector("#reviewCount"),
  commentCount: document.querySelector("#commentCount"),
  reportCount: document.querySelector("#reportCount"),
  appealCount: document.querySelector("#appealCount"),
  workForm: document.querySelector("#workForm"),
  workTitle: document.querySelector("#workTitle"),
  workSlug: document.querySelector("#workSlug"),
  workCreator: document.querySelector("#workCreator"),
  workType: document.querySelector("#workType"),
  workYear: document.querySelector("#workYear"),
  workSummary: document.querySelector("#workSummary"),
  workFormError: document.querySelector("#workFormError"),
  workList: document.querySelector("#workList"),
  detectiveForm: document.querySelector("#detectiveForm"),
  detectiveFormTitle: document.querySelector("#detectiveFormTitle"),
  detectiveName: document.querySelector("#detectiveName"),
  detectiveCatalogId: document.querySelector("#detectiveCatalogId"),
  detectiveSlug: document.querySelector("#detectiveSlug"),
  detectiveOriginalName: document.querySelector("#detectiveOriginalName"),
  detectiveEnglishName: document.querySelector("#detectiveEnglishName"),
  detectiveCountry: document.querySelector("#detectiveCountry"),
  detectiveEra: document.querySelector("#detectiveEra"),
  detectiveSubjectKind: document.querySelector("#detectiveSubjectKind"),
  detectiveCollection: document.querySelector("#detectiveCollection"),
  detectiveCategory: document.querySelector("#detectiveCategory"),
  detectiveCreator: document.querySelector("#detectiveCreator"),
  detectiveMediaTypes: document.querySelector("#detectiveMediaTypes"),
  detectiveAliases: document.querySelector("#detectiveAliases"),
  detectiveTags: document.querySelector("#detectiveTags"),
  detectiveCases: document.querySelector("#detectiveCases"),
  detectiveSummary: document.querySelector("#detectiveSummary"),
  detectiveSourceNote: document.querySelector("#detectiveSourceNote"),
  detectiveSourceLabel: document.querySelector("#detectiveSourceLabel"),
  detectiveSourceQuality: document.querySelector("#detectiveSourceQuality"),
  detectiveSourceUrl: document.querySelector("#detectiveSourceUrl"),
  detectiveVerification: document.querySelector("#detectiveVerification"),
  detectiveSubmitButton: document.querySelector("#detectiveSubmitButton"),
  cancelDetectiveEdit: document.querySelector("#cancelDetectiveEdit"),
  detectiveFormError: document.querySelector("#detectiveFormError"),
  detectiveList: document.querySelector("#detectiveList"),
  linkReviewCount: document.querySelector("#linkReviewCount"),
  linkReviewList: document.querySelector("#linkReviewList"),
  linkReviewSearchForm: document.querySelector("#linkReviewSearchForm"),
  linkReviewSearch: document.querySelector("#linkReviewSearch"),
  linkFeedbackList: document.querySelector("#linkFeedbackList"),
  userList: document.querySelector("#userList"),
  auditList: document.querySelector("#auditList")
};

let editingDetective = null;
let currentAdminRole = null;
let linkReviewQuery = "";

function getToken() {
  return sessionStorage.getItem(tokenKey) || "";
}

async function api(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {})
    },
    ...(options.data ? { body: JSON.stringify(options.data) } : {})
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(body?.message || "请求失败");
  }
  return body;
}

const maxAutomaticPages = 100;

function pagedPath(path, page) {
  return `${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=50`;
}

async function listAllAdminPages(path) {
  const data = [];
  let page = 1;
  let totalPages = 1;
  let total = 0;
  do {
    const response = await api(pagedPath(path, page));
    data.push(...response.data);
    total = response.pagination?.total ?? data.length;
    totalPages = response.pagination?.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages && page <= maxAutomaticPages);
  if (page <= totalPages) throw new Error("后台列表超过自动加载上限，请先使用筛选条件缩小范围");
  return { data, total };
}

async function listAllModerationPages() {
  const result = { reviews: [], comments: [], reports: [], appeals: [] };
  const totals = { reviews: 0, comments: 0, reports: 0, appeals: 0 };
  let page = 1;
  let totalPages = 1;
  do {
    const response = await api(pagedPath("/admin/moderation", page));
    result.reviews.push(...response.data.reviews);
    result.comments.push(...response.data.comments);
    result.reports.push(...response.data.reports);
    result.appeals.push(...response.data.appeals);
    for (const type of ["reviews", "comments", "reports", "appeals"]) {
      totals[type] = response.pagination?.[type]?.total ?? result[type].length;
    }
    totalPages = Math.max(
      response.pagination?.reviews?.totalPages ?? 1,
      response.pagination?.comments?.totalPages ?? 1,
      response.pagination?.reports?.totalPages ?? 1,
      response.pagination?.appeals?.totalPages ?? 1
    );
    page += 1;
  } while (page <= totalPages && page <= maxAutomaticPages);
  if (page <= totalPages) throw new Error("待处理内容超过自动加载上限，请分批处理后刷新");
  return { data: result, totals };
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function showLogin() {
  sessionStorage.removeItem(tokenKey);
  currentAdminRole = null;
  elements.loginPanel.classList.remove("hidden");
  elements.workspace.classList.add("hidden");
  elements.logoutButton.classList.add("hidden");
}

function showWorkspace() {
  elements.loginPanel.classList.add("hidden");
  elements.workspace.classList.remove("hidden");
  elements.logoutButton.classList.remove("hidden");
}

function renderMetrics(data) {
  const metrics = [
    ["用户", data.userCount],
    ["已发布侦探", data.publishedDetectiveCount],
    ["已发布作品", data.publishedWorkCount],
    ["待审内容", data.pendingReviewCount + data.pendingCommentCount],
    ["待处理举报", data.openReportCount],
    ["待处理申诉", data.openAppealCount],
    ["链接反馈", data.openLinkFeedbackCount],
    ["确认失效链接", data.brokenLinkCount],
    ["待人工复核", data.unconfirmedLinkCount],
    ["超期未巡检", data.staleLinkCount]
  ];
  elements.metrics.replaceChildren(...metrics.map(([label, value]) => {
    const card = document.createElement("article");
    card.className = "metric-card";
    card.append(textElement("strong", "metric-value", String(value)));
    card.append(textElement("span", "metric-label", label));
    return card;
  }));
}

function renderAnalytics(data) {
  const formatRate = (value) => `${Number(value || 0).toFixed(2)}%`;
  const formatHours = (value) => value === null ? "暂无样本" : `${Number(value).toFixed(2)} 小时`;
  const metrics = [
    ["档案详情访问率", formatRate(data.archiveDetail.rate), `${data.archiveDetail.detailVisitors} / ${data.archiveDetail.listVisitors} 位访客`],
    ["正版渠道点击率", formatRate(data.officialLink.rate), `${data.officialLink.clickVisitors} / ${data.officialLink.detailVisitors} 位访客`],
    ["新用户 7 日首加书架", formatRate(data.firstShelf.rate), `${data.firstShelf.convertedUsers} / ${data.firstShelf.newUsers} 位已观察满 7 天的新用户`],
    ["完成后发布评价", formatRate(data.completedReview.rate), `${data.completedReview.reviewedWorks} / ${data.completedReview.completedWorks} 条完成记录`],
    ["7 日留存", formatRate(data.retention.day7.rate), `${data.retention.day7.retainedUsers} / ${data.retention.day7.eligibleUsers} 位到期用户`],
    ["30 日留存", formatRate(data.retention.day30.rate), `${data.retention.day30.retainedUsers} / ${data.retention.day30.eligibleUsers} 位到期用户`],
    ["评论举报率", formatRate(data.communityModeration.commentReportRate), `${data.communityModeration.reportedComments} / ${data.communityModeration.publishedComments} 条评论`],
    ["平均审核时长", formatHours(data.communityModeration.averageModerationHours), `${data.communityModeration.moderationDecisions} 次首次审核`],
    ["申诉恢复率", formatRate(data.communityModeration.appealRecoveryRate), `${data.communityModeration.approvedAppeals} / ${data.communityModeration.handledAppeals} 条已结申诉`]
  ];
  elements.analyticsPeriod.textContent = `统计周期：最近 ${data.periodDays} 天；匿名访问按本地随机标识摘要去重，首加书架仅统计已观察满 7 天的新用户，留存按 UTC 自然日计算。`;
  elements.analyticsMetrics.replaceChildren(...metrics.map(([label, value, note]) => {
    const card = document.createElement("article");
    card.className = "metric-card";
    card.append(textElement("strong", "metric-value", value));
    card.append(textElement("span", "metric-label", label));
    card.append(textElement("span", "metric-note", note));
    return card;
  }));
}

function actionButton(label, className, callback) {
  const button = textElement("button", className, label);
  button.type = "button";
  button.addEventListener("click", callback);
  return button;
}

async function moderate(targetType, targetId, action) {
  const reason = window.prompt("请输入审核理由（至少 2 个字）");
  if (!reason || reason.trim().length < 2) return;
  await api(`/admin/moderation/${targetType}/${targetId}`, {
    method: "POST",
    data: { action, reason: reason.trim() }
  });
  await loadWorkspace();
}

function renderContentQueue(container, items, targetType) {
  if (!items.length) {
    container.replaceChildren(textElement("p", "empty", "当前没有待审内容"));
    return;
  }
  container.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "queue-card";
    const context = targetType === "REVIEW"
      ? `${item.work.titleZh} · ${item.author.displayName}`
      : `回复 ${item.author.displayName}`;
    card.append(textElement("div", "queue-context", context));
    if (item.title) card.append(textElement("h4", "queue-title", item.title));
    card.append(textElement("p", "queue-body", item.body));
    if (item.containsSpoiler) card.append(textElement("span", "spoiler-tag", "含剧透"));
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.append(actionButton("发布", "approve-button", () => moderate(targetType, item.id, "PUBLISH")));
    actions.append(actionButton("拒绝", "reject-button", () => moderate(targetType, item.id, "REJECT")));
    card.append(actions);
    return card;
  }));
}

async function resolveReport(reportId, status) {
  const note = window.prompt("请输入处理结论（至少 2 个字）");
  if (!note || note.trim().length < 2) return;
  await api(`/admin/reports/${reportId}`, {
    method: "PATCH",
    data: { status, resolutionNote: note.trim() }
  });
  await loadWorkspace();
}

function renderReports(items) {
  if (!items.length) {
    elements.reportQueue.replaceChildren(textElement("p", "empty", "当前没有待处理举报"));
    return;
  }
  elements.reportQueue.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "queue-card";
    card.append(textElement("div", "queue-context", `${item.targetType} · ${item.reasonCode}`));
    card.append(textElement("p", "queue-body", item.targetPreview || "目标内容已不可见"));
    if (item.description) card.append(textElement("p", "report-description", item.description));
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.append(actionButton("已处理", "approve-button", () => resolveReport(item.id, "RESOLVED")));
    actions.append(actionButton("驳回", "reject-button", () => resolveReport(item.id, "REJECTED")));
    card.append(actions);
    return card;
  }));
}

async function resolveAppeal(appealId, status) {
  const note = window.prompt("请输入申诉处理结论（至少 2 个字）");
  if (!note || note.trim().length < 2) return;
  await api(`/admin/appeals/${appealId}`, {
    method: "PATCH",
    data: { status, resolutionNote: note.trim() }
  });
  await loadWorkspace();
}

function renderAppeals(items) {
  if (!items.length) {
    elements.appealQueue.replaceChildren(textElement("p", "empty", "当前没有待处理申诉"));
    return;
  }
  elements.appealQueue.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "queue-card";
    card.append(textElement("div", "queue-context", `${item.targetType} · ${item.appellant.displayName}`));
    card.append(textElement("p", "queue-body", item.targetPreview || "原内容不可用"));
    card.append(textElement("p", "report-description", `申诉说明：${item.reason}`));
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.append(actionButton("恢复内容", "approve-button", () => resolveAppeal(item.id, "APPROVED")));
    actions.append(actionButton("维持处理", "reject-button", () => resolveAppeal(item.id, "REJECTED")));
    card.append(actions);
    return card;
  }));
}

async function changeWorkStatus(workId, status) {
  await api(`/admin/works/${workId}/status`, { method: "POST", data: { status } });
  await loadWorkspace();
}

async function addWorkLink(workId) {
  const providerName = window.prompt("渠道名称，例如“出版社官网”");
  if (!providerName) return;
  const url = window.prompt("HTTPS 正版渠道地址");
  if (!url) return;
  const linkType = window.prompt(
    "渠道类型：PUBLISHER / BOOKSTORE / LIBRARY / STREAMING / OFFICIAL_SITE / OTHER",
    "PUBLISHER"
  );
  if (!linkType) return;
  await api(`/admin/works/${workId}/links`, {
    method: "POST",
    data: { providerName, url, linkType, region: "CN" }
  });
  await loadWorkspace();
}

async function toggleWorkLink(link) {
  await api(`/admin/work-links/${link.id}`, {
    method: "PATCH",
    data: { isActive: !link.isActive }
  });
  await loadWorkspace();
}

async function reviewWorkLink(item, decision) {
  const note = window.prompt(
    decision === "VERIFIED" ? "说明确认有效的依据（至少 5 个字）" : "说明确认失效的依据（至少 5 个字）"
  );
  if (!note) return;
  const evidenceReference = window.prompt(
    "证据引用，例如出版社页面、工单号或受控截图编号；不要粘贴带令牌或签名的地址"
  );
  if (!evidenceReference) return;
  elements.workspaceError.textContent = "";
  try {
    await api(`/admin/work-links/${item.id}/review`, {
      method: "PATCH",
      data: { decision, note, evidenceReference }
    });
    await loadWorkspace();
  } catch (error) {
    elements.workspaceError.textContent = error.message;
  }
}

function renderLinkReviews(items, total) {
  elements.linkReviewCount.textContent = String(total);
  if (!items.length) {
    elements.linkReviewList.replaceChildren(textElement("p", "empty", "当前没有待人工复核的正版链接"));
    return;
  }
  const stateLabels = {
    BROKEN: "自动巡检确认失效",
    NEVER_CHECKED: "尚未巡检",
    STALE: "超过 90 天未确认",
    UNCONFIRMED: "自动巡检无法确认"
  };
  elements.linkReviewList.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "queue-card";
    card.append(textElement("h4", "queue-title", item.work.titleZh));
    card.append(textElement(
      "div",
      "queue-context",
      `${item.providerName} · ${stateLabels[item.reviewState] || item.reviewState}`
    ));
    const details = item.lastCheckError || item.lastStatusCode
      ? `巡检结果：${item.lastCheckError || `HTTP ${item.lastStatusCode}`}`
      : "巡检结果：暂无自动证据";
    card.append(textElement("p", "queue-body", details));
    if (item.manualReviewedAt) {
      card.append(textElement(
        "p",
        "report-description",
        `上次人工结论：${item.manualReviewStatus} · ${item.manualReviewer?.displayName || "未知人员"} · ${new Date(item.manualReviewedAt).toLocaleString("zh-CN")}`
      ));
    }
    const actions = document.createElement("div");
    actions.className = "card-actions";
    try {
      const url = new URL(item.url);
      if (url.protocol === "https:") {
        const anchor = textElement("a", "text-button", "打开正版入口");
        anchor.href = url.toString();
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        actions.append(anchor);
      }
    } catch {
      // Invalid stored URLs remain visible to administrators but are not made clickable.
    }
    if (currentAdminRole === "ADMIN") {
      if (item.reviewState !== "BROKEN") {
        actions.append(actionButton("人工确认有效", "approve-button", () => reviewWorkLink(item, "VERIFIED")));
      }
      actions.append(actionButton("确认失效并停用", "reject-button", () => reviewWorkLink(item, "REJECTED")));
    } else {
      actions.append(textElement("span", "queue-context", "需管理员登记最终结论"));
    }
    card.append(actions);
    return card;
  }));
}

function renderWorks(items) {
  if (!items.length) {
    elements.workList.replaceChildren(textElement("p", "empty", "尚无作品"));
    return;
  }
  elements.workList.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "queue-card work-card";
    const heading = document.createElement("div");
    heading.className = "work-heading";
    heading.append(textElement("h4", "queue-title", item.titleZh));
    heading.append(textElement("span", `status status-${item.status.toLowerCase()}`, item.status));
    card.append(heading);
    card.append(textElement("div", "queue-context", `${item.slug} · ${item.mediaType}`));
    if (item.summary) card.append(textElement("p", "queue-body", item.summary));
    const actions = document.createElement("div");
    actions.className = "card-actions";
    if (item.status === "DRAFT") {
      actions.append(actionButton("提交审核", "approve-button", () => changeWorkStatus(item.id, "PENDING_REVIEW")));
    } else if (item.status === "PENDING_REVIEW") {
      actions.append(actionButton("发布", "approve-button", () => changeWorkStatus(item.id, "PUBLISHED")));
    } else if (item.status === "PUBLISHED") {
      actions.append(actionButton("隐藏", "reject-button", () => changeWorkStatus(item.id, "HIDDEN")));
    } else if (item.status === "HIDDEN") {
      actions.append(actionButton("恢复发布", "approve-button", () => changeWorkStatus(item.id, "PUBLISHED")));
    }
    actions.append(actionButton("新增正版链接", "secondary-small", () => addWorkLink(item.id)));
    card.append(actions);
    if (item.links.length) {
      const links = document.createElement("div");
      links.className = "link-list";
      item.links.forEach((link) => {
        const row = document.createElement("div");
        row.className = "link-row";
        const health = link.lastCheckOk === null
          ? link.lastCheckError
            ? `待复核 ${link.lastCheckError}`
            : "待巡检"
          : link.lastCheckOk
            ? `正常 ${link.lastStatusCode || ""}`.trim()
            : `确认失效 ${link.lastCheckError || link.lastStatusCode || "未知"}`;
        row.append(textElement(
          "span",
          "",
          `${link.providerName} · ${link.isActive ? "启用" : "停用"} · ${health} · 点击 ${link.clickCount} · 待处理 ${link.openFeedbackCount}`
        ));
        row.append(actionButton(link.isActive ? "停用" : "启用", "text-button", () => toggleWorkLink(link)));
        links.append(row);
      });
      card.append(links);
    }
    return card;
  }));
}

function commaValues(value) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function lineValues(value) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function detectivePayload() {
  const sourceLabel = elements.detectiveSourceLabel.value.trim();
  const sourceUrl = elements.detectiveSourceUrl.value.trim();
  return {
    catalogId: elements.detectiveCatalogId.value.trim() || undefined,
    slug: elements.detectiveSlug.value.trim(),
    nameZh: elements.detectiveName.value.trim(),
    nameOriginal: elements.detectiveOriginalName.value.trim() || undefined,
    nameEn: elements.detectiveEnglishName.value.trim() || undefined,
    country: elements.detectiveCountry.value.trim() || undefined,
    era: elements.detectiveEra.value.trim() || undefined,
    subjectKind: elements.detectiveSubjectKind.value,
    collection: elements.detectiveCollection.value,
    category: elements.detectiveCategory.value || undefined,
    mediaTypes: commaValues(elements.detectiveMediaTypes.value.toUpperCase()),
    summary: elements.detectiveSummary.value.trim(),
    sourceNote: elements.detectiveSourceNote.value.trim() || undefined,
    verification: elements.detectiveVerification.value,
    creatorName: elements.detectiveCreator.value.trim() || undefined,
    aliases: commaValues(elements.detectiveAliases.value),
    tags: commaValues(elements.detectiveTags.value),
    featuredCases: lineValues(elements.detectiveCases.value),
    sources: sourceLabel && sourceUrl ? [{
      label: sourceLabel,
      url: sourceUrl,
      quality: elements.detectiveSourceQuality.value.trim().toUpperCase(),
      verification: elements.detectiveVerification.value
    }] : []
  };
}

function resetDetectiveForm() {
  editingDetective = null;
  elements.detectiveForm.reset();
  elements.detectiveSourceQuality.value = "PUBLISHER";
  elements.detectiveFormTitle.textContent = "新建侦探档案";
  elements.detectiveSubmitButton.textContent = "保存草稿";
  elements.cancelDetectiveEdit.classList.add("hidden");
  elements.detectiveFormError.textContent = "";
}

function editDetective(item) {
  editingDetective = item;
  elements.detectiveName.value = item.nameZh || "";
  elements.detectiveCatalogId.value = item.catalogId || "";
  elements.detectiveSlug.value = item.slug || "";
  elements.detectiveOriginalName.value = item.nameOriginal || "";
  elements.detectiveEnglishName.value = item.nameEn || "";
  elements.detectiveCountry.value = item.country || "";
  elements.detectiveEra.value = item.era || "";
  elements.detectiveSubjectKind.value = item.subjectKind || "FICTIONAL";
  elements.detectiveCollection.value = item.collection || "CORE";
  elements.detectiveCategory.value = item.category || "";
  elements.detectiveCreator.value = item.creatorName || "";
  elements.detectiveMediaTypes.value = (item.mediaTypes || []).join(",");
  elements.detectiveAliases.value = (item.aliases || []).join(",");
  elements.detectiveTags.value = (item.tags || []).join(",");
  elements.detectiveCases.value = (item.featuredCases || []).join("\n");
  elements.detectiveSummary.value = item.summary || "";
  elements.detectiveSourceNote.value = item.sourceNote || "";
  const source = item.sources?.[0];
  elements.detectiveSourceLabel.value = source?.label || "";
  elements.detectiveSourceUrl.value = source?.url || "";
  elements.detectiveSourceQuality.value = source?.quality || "PUBLISHER";
  elements.detectiveVerification.value = item.verification || "SOURCE_CAPTURED";
  elements.detectiveFormTitle.textContent = `编辑：${item.nameZh}`;
  elements.detectiveSubmitButton.textContent = "保存修改";
  elements.cancelDetectiveEdit.classList.remove("hidden");
  elements.detectiveForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function changeDetectiveStatus(detectiveId, status) {
  await api(`/admin/detectives/${detectiveId}/status`, { method: "POST", data: { status } });
  await loadWorkspace();
}

function renderDetectives(items) {
  if (!items.length) {
    elements.detectiveList.replaceChildren(textElement("p", "empty", "尚无侦探档案"));
    return;
  }
  elements.detectiveList.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "queue-card work-card";
    const heading = document.createElement("div");
    heading.className = "work-heading";
    heading.append(textElement("h4", "queue-title", item.nameZh));
    heading.append(textElement("span", `status status-${item.status.toLowerCase()}`, item.status));
    card.append(heading);
    card.append(textElement(
      "div",
      "queue-context",
      `${item.catalogId || "未编号"} · ${item.slug} · ${item.country || "地区待补"}`
    ));
    card.append(textElement("p", "queue-body clamp", item.summary));
    if (item.featuredCases.length) {
      card.append(textElement("p", "case-list", `代表案件：${item.featuredCases.join("、")}`));
    }
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.append(actionButton("编辑", "secondary-small", () => editDetective(item)));
    if (item.status === "DRAFT") {
      actions.append(actionButton("提交审核", "approve-button", () => changeDetectiveStatus(item.id, "PENDING_REVIEW")));
    } else if (item.status === "PENDING_REVIEW") {
      actions.append(actionButton("发布", "approve-button", () => changeDetectiveStatus(item.id, "PUBLISHED")));
    } else if (item.status === "PUBLISHED") {
      actions.append(actionButton("隐藏", "reject-button", () => changeDetectiveStatus(item.id, "HIDDEN")));
    } else if (item.status === "HIDDEN") {
      actions.append(actionButton("恢复发布", "approve-button", () => changeDetectiveStatus(item.id, "PUBLISHED")));
    }
    card.append(actions);
    return card;
  }));
}

async function resolveLinkFeedback(item, status) {
  const note = window.prompt("请输入处理结论（至少 2 个字）");
  if (!note || note.trim().length < 2) return;
  const deactivateLink = status === "RESOLVED"
    && item.link.isActive
    && window.confirm("是否同时停用这条正版链接？");
  await api(`/admin/work-link-feedback/${item.id}`, {
    method: "PATCH",
    data: { status, resolutionNote: note.trim(), deactivateLink }
  });
  await loadWorkspace();
}

function renderLinkFeedback(items) {
  if (!items.length) {
    elements.linkFeedbackList.replaceChildren(textElement("p", "empty", "当前没有待处理的链接反馈"));
    return;
  }
  elements.linkFeedbackList.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "queue-card";
    card.append(textElement("div", "queue-context", `${item.link.workTitle} · ${item.reasonCode}`));
    card.append(textElement("h4", "queue-title", item.link.providerName));
    card.append(textElement("p", "queue-body break-all", item.link.url));
    card.append(textElement("p", "case-list", `累计点击 ${item.clickCount} 次 · ${item.reporter?.displayName || "匿名反馈"}`));
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.append(actionButton("处理", "approve-button", () => resolveLinkFeedback(item, "RESOLVED")));
    actions.append(actionButton("驳回", "reject-button", () => resolveLinkFeedback(item, "REJECTED")));
    card.append(actions);
    return card;
  }));
}

async function changeUserRole(user, select) {
  await api(`/admin/users/${user.id}/role`, {
    method: "PATCH",
    data: { role: select.value }
  });
  await loadWorkspace();
}

function renderUsers(items) {
  if (!items.length) {
    elements.userList.replaceChildren(textElement("p", "empty", "尚无用户"));
    return;
  }
  elements.userList.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "queue-card user-card";
    card.append(textElement("h4", "queue-title", item.displayName));
    card.append(textElement("div", "queue-context", `${item.providers.join(" / ") || "无登录身份"} · ${item.isActive ? "有效" : "已注销"}`));
    const select = document.createElement("select");
    ["USER", "EDITOR", "MODERATOR", "ADMIN"].forEach((role) => {
      const option = textElement("option", "", role);
      option.value = role;
      option.selected = item.role === role;
      select.append(option);
    });
    const actions = document.createElement("div");
    actions.className = "role-actions";
    actions.append(select);
    actions.append(actionButton("保存角色", "secondary-small", () => changeUserRole(item, select)));
    card.append(actions);
    return card;
  }));
}

function renderAuditLogs(items) {
  if (!items.length) {
    elements.auditList.replaceChildren(textElement("p", "empty", "尚无审计记录"));
    return;
  }
  elements.auditList.replaceChildren(...items.map((item) => {
    const row = document.createElement("article");
    row.className = "audit-row";
    row.append(textElement("strong", "", item.action));
    row.append(textElement("span", "", `${item.resourceType} · ${item.actor?.displayName || "系统"}`));
    row.append(textElement("time", "", new Date(item.createdAt).toLocaleString("zh-CN")));
    return row;
  }));
}

async function loadWorkspace() {
  elements.workspaceError.textContent = "";
  try {
    const linkReviewPath = linkReviewQuery
      ? `/admin/work-link-reviews?q=${encodeURIComponent(linkReviewQuery)}`
      : "/admin/work-link-reviews";
    const [dashboard, analytics, moderation, works, detectives, linkReviews, linkFeedback, users, audits] = await Promise.all([
      api("/admin/dashboard"),
      api("/admin/analytics?days=90"),
      listAllModerationPages(),
      listAllAdminPages("/admin/works"),
      listAllAdminPages("/admin/detectives"),
      listAllAdminPages(linkReviewPath),
      listAllAdminPages("/admin/work-link-feedback"),
      listAllAdminPages("/admin/users"),
      listAllAdminPages("/admin/audit-logs")
    ]);
    showWorkspace();
    renderMetrics(dashboard.data);
    renderAnalytics(analytics.data);
    const queue = moderation.data;
    elements.reviewCount.textContent = String(moderation.totals.reviews);
    elements.commentCount.textContent = String(moderation.totals.comments);
    elements.reportCount.textContent = String(moderation.totals.reports);
    elements.appealCount.textContent = String(moderation.totals.appeals);
    renderContentQueue(elements.reviewQueue, queue.reviews, "REVIEW");
    renderContentQueue(elements.commentQueue, queue.comments, "COMMENT");
    renderReports(queue.reports);
    renderAppeals(queue.appeals);
    renderWorks(works.data);
    renderDetectives(detectives.data);
    renderLinkReviews(linkReviews.data, linkReviews.total);
    renderLinkFeedback(linkFeedback.data);
    renderUsers(users.data);
    renderAuditLogs(audits.data);
  } catch (error) {
    elements.workspaceError.textContent = error.message;
  }
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginError.textContent = "";
  try {
    const response = await api("/auth/admin", {
      method: "POST",
      data: { loginId: elements.loginId.value, password: elements.password.value }
    });
    sessionStorage.setItem(tokenKey, response.data.token);
    currentAdminRole = response.data.user.role;
    elements.password.value = "";
    await loadWorkspace();
  } catch (error) {
    elements.loginError.textContent = error.message;
  }
});

elements.logoutButton.addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    showLogin();
  }
});
elements.refreshButton.addEventListener("click", loadWorkspace);
elements.linkReviewSearchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  linkReviewQuery = elements.linkReviewSearch.value.trim();
  await loadWorkspace();
});
elements.workForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.workFormError.textContent = "";
  try {
    await api("/admin/works", {
      method: "POST",
      data: {
        titleZh: elements.workTitle.value.trim(),
        slug: elements.workSlug.value.trim(),
        creatorName: elements.workCreator.value.trim() || undefined,
        mediaType: elements.workType.value,
        releaseYear: elements.workYear.value ? Number(elements.workYear.value) : undefined,
        summary: elements.workSummary.value.trim() || undefined
      }
    });
    elements.workForm.reset();
    await loadWorkspace();
  } catch (error) {
    elements.workFormError.textContent = error.message;
  }
});

elements.detectiveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.detectiveFormError.textContent = "";
  try {
    await api(
      editingDetective ? `/admin/detectives/${editingDetective.id}` : "/admin/detectives",
      {
        method: editingDetective ? "PATCH" : "POST",
        data: detectivePayload()
      }
    );
    resetDetectiveForm();
    await loadWorkspace();
  } catch (error) {
    elements.detectiveFormError.textContent = error.message;
  }
});
elements.cancelDetectiveEdit.addEventListener("click", resetDetectiveForm);

async function restoreAdminSession() {
  if (!getToken()) {
    showLogin();
    return;
  }
  try {
    const response = await api("/auth/refresh", { method: "POST" });
    sessionStorage.setItem(tokenKey, response.data.token);
    currentAdminRole = response.data.user.role;
    await loadWorkspace();
  } catch (error) {
    showLogin();
  }
}

restoreAdminSession();
