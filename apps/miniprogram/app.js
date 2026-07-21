const releaseConfig = require("./config");
const api = require("./services/api");

App({
  globalData: {
    ...releaseConfig
  },
  onLaunch() {
    if (api.hasAuthToken()) {
      api.refreshSession().catch(() => {});
    }
  }
});
