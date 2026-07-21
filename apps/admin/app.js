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
  workList: document.querySelector("#workList")
};

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
    if (item.status !== "PUBLISHED") {
      actions.append(actionButton("发布", "approve-button", () => changeWorkStatus(item.id, "PUBLISHED")));
    } else {
      actions.append(actionButton("隐藏", "reject-button", () => changeWorkStatus(item.id, "HIDDEN")));
    }
    actions.append(actionButton("新增正版链接", "secondary-small", () => addWorkLink(item.id)));
    card.append(actions);
    if (item.links.length) {
      const links = document.createElement("div");
      links.className = "link-list";
      item.links.forEach((link) => {
        const row = document.createElement("div");
        row.className = "link-row";
        row.append(textElement("span", "", `${link.providerName} · ${link.isActive ? "启用" : "停用"}`));
        row.append(actionButton(link.isActive ? "停用" : "启用", "text-button", () => toggleWorkLink(link)));
        links.append(row);
      });
      card.append(links);
    }
    return card;
  }));
}

async function loadWorkspace() {
  elements.workspaceError.textContent = "";
  try {
    const [dashboard, moderation, works] = await Promise.all([
      api("/admin/dashboard"),
      api("/admin/moderation"),
      api("/admin/works")
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

if (getToken()) loadWorkspace();
else showLogin();
