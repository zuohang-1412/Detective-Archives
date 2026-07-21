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
  reviewQueue: document.querySelector("#reviewQueue"),
  commentQueue: document.querySelector("#commentQueue"),
  reportQueue: document.querySelector("#reportQueue"),
  reviewCount: document.querySelector("#reviewCount"),
  commentCount: document.querySelector("#commentCount"),
  reportCount: document.querySelector("#reportCount"),
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
  linkFeedbackList: document.querySelector("#linkFeedbackList"),
  userList: document.querySelector("#userList"),
  auditList: document.querySelector("#auditList")
};

let editingDetective = null;

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

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function showLogin() {
  sessionStorage.removeItem(tokenKey);
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
    ["链接反馈", data.openLinkFeedbackCount],
    ["待复核链接", data.staleLinkCount]
  ];
  elements.metrics.replaceChildren(...metrics.map(([label, value]) => {
    const card = document.createElement("article");
    card.className = "metric-card";
    card.append(textElement("strong", "metric-value", String(value)));
    card.append(textElement("span", "metric-label", label));
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
          ? "待巡检"
          : link.lastCheckOk
            ? `正常 ${link.lastStatusCode || ""}`.trim()
            : `异常 ${link.lastCheckError || link.lastStatusCode || "未知"}`;
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
    const [dashboard, moderation, works, detectives, linkFeedback, users, audits] = await Promise.all([
      api("/admin/dashboard"),
      api("/admin/moderation"),
      api("/admin/works"),
      api("/admin/detectives"),
      api("/admin/work-link-feedback"),
      api("/admin/users?pageSize=50"),
      api("/admin/audit-logs?pageSize=50")
    ]);
    showWorkspace();
    renderMetrics(dashboard.data);
    const queue = moderation.data;
    elements.reviewCount.textContent = String(queue.reviews.length);
    elements.commentCount.textContent = String(queue.comments.length);
    elements.reportCount.textContent = String(queue.reports.length);
    renderContentQueue(elements.reviewQueue, queue.reviews, "REVIEW");
    renderContentQueue(elements.commentQueue, queue.comments, "COMMENT");
    renderReports(queue.reports);
    renderWorks(works.data);
    renderDetectives(detectives.data);
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
    await loadWorkspace();
  } catch (error) {
    showLogin();
  }
}

restoreAdminSession();
