window.__ModuleLoader__.load({
	id: "@local/dsh-codex-adapter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		const { IconChevronDownOutline14, IconRefreshOutline14 } = require("@deepseek-ai/dsh-client-ui-primitives");
		const NS = "llm-codex-subscription";
		const API_ROOT = "/plugins/@local/dsh-codex-adapter/api";
		const AUTH_PATHS = Object.freeze({
			status: `${API_ROOT}/auth/status`,
			login: `${API_ROOT}/auth/login`,
			cancel: `${API_ROOT}/auth/cancel`,
			logout: `${API_ROOT}/auth/logout`,
		});
		const h = React.createElement;

		const css = `
.dca-card{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);list-style:none;transition:border-color .16s,background .16s}
.dca-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dca-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dca-header{box-sizing:border-box;appearance:none;display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;border:0;border-radius:12px;color:inherit;background:transparent;text-align:left;cursor:pointer;font:inherit}
.dca-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dca-head-text{display:flex;min-width:0;flex:1;flex-direction:column;gap:4px}
.dca-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dca-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dca-pending{flex:none;padding:1px 8px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.dca-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.dca-chevron-open{transform:rotate(180deg)}
.dca-body{margin:0 16px;padding-bottom:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.dca-auth{display:grid;gap:8px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dca-auth-head{display:flex;align-items:center;gap:8px;min-height:32px}
.dca-auth-title{min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.dca-auth-state{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dca-auth-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dca-auth-link{color:var(--dsw-alias-brand-primary);font-size:13px;line-height:1.5}
.dca-auth-code{padding:4px 8px;border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);font:600 14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.dca-auth-error{margin:0;color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5}
.dca-quota{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dca-quota-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dca-quota-title{min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.dca-quota-refresh{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
.dca-quota-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dca-quota-refresh:disabled{cursor:default;opacity:.4}
.dca-quota-buckets{display:grid;gap:10px}
.dca-quota-bucket+.dca-quota-bucket{padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
.dca-quota-name{display:flex;align-items:center;gap:8px;margin-bottom:6px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.dca-quota-plan{padding:1px 7px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);font-size:11px;font-weight:500;line-height:17px;text-transform:capitalize}
.dca-quota-windows{display:grid;gap:7px}
.dca-quota-credit{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dca-quota-window{display:grid;grid-template-columns:minmax(80px,auto) 1fr auto;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dca-quota-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-module-platform);overflow:hidden}
.dca-quota-used{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary)}
.dca-quota-reset{grid-column:2/-1;color:var(--dsw-alias-label-dimmed);font-size:11px}
.dca-quota-error{margin:0;color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5}
.dca-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dca-field+.dca-field{border-top:1px solid var(--dsw-alias-border-l2)}
.dca-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.dca-toggle{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5;cursor:pointer}
.dca-toggle input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.dca-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dca-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 0}
.dca-catalog{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:12px}
.dca-models{display:grid}
.dca-model{display:grid;gap:8px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.dca-model:first-child{border-top:0}
.dca-model-main{display:grid;grid-template-columns:minmax(150px,1fr) minmax(130px,1fr) 34px;gap:8px}
.dca-model-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.dca-button{box-sizing:border-box;appearance:none;min-height:32px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.dca-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dca-button:disabled{cursor:default;opacity:.4}
.dca-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dca-candidate{min-height:28px;padding:3px 9px;font-size:12px}
.dca-remove{width:34px;padding:0;color:var(--dsw-alias-label-error)}
.dca-input{box-sizing:border-box;min-width:0;height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5}
.dca-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dca-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dca-status,.dca-readonly,.dca-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dca-readonly{margin-top:12px}
.dca-empty{padding:4px 0 12px}
.dca-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.dca-failed,.dca-footer-status{min-width:0;flex:1;margin:0;color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5}
.dca-footer-status{color:var(--dsw-alias-label-tertiary)}
.dca-discard,.dca-save{appearance:none;padding:5px 14px;border:1px solid transparent;border-radius:8px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.dca-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}
.dca-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dca-save{color:var(--dsw-alias-bg-layer-3);background:var(--dsw-alias-label-primary)}
.dca-discard:disabled,.dca-save:disabled{cursor:default;opacity:.4}
.dca-discard:focus-visible,.dca-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@media(max-width:640px){.dca-model-main{grid-template-columns:minmax(0,1fr) 34px}.dca-model-main .dca-input:nth-child(2){grid-column:1/-1;grid-row:2}.dca-remove{grid-column:2;grid-row:1}.dca-model-options{grid-template-columns:minmax(0,1fr)}}
`;
		if (document.querySelector("style[data-dsh-codex-adapter]") === null) {
			const style = document.createElement("style");
			style.dataset.dshCodexAdapter = "";
			style.textContent = css;
			document.head.appendChild(style);
		}

		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		async function authRequest(route, method = "GET") {
			const response = await fetch(AUTH_PATHS[route], {
				method,
				cache: "no-store",
				headers: method === "POST"
					? { "content-type": "application/json", "x-dsh-codex-adapter-auth": "1" }
					: undefined,
				body: method === "POST" ? "{}" : undefined,
			});
			let body;
			try {
				body = await response.json();
			} catch {
				throw new Error(`HTTP ${response.status}`);
			}
			if (!response.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${response.status}`);
			return body.value;
		}

		function AuthPanel({ onSignedIn }) {
			const [account, setAccount] = React.useState(null);
			const [login, setLogin] = React.useState(null);
			const [loading, setLoading] = React.useState(true);
			const [busy, setBusy] = React.useState(false);
			const [failure, setFailure] = React.useState("");
			const signedInRef = React.useRef(false);

			const loadStatus = React.useCallback(async (silent = false) => {
				if (!silent) setLoading(true);
				try {
					const value = await authRequest("status");
					if (value === null || typeof value !== "object") throw new Error("登录状态响应无效");
					setAccount(value);
					if (value.signedIn === true) {
						setLogin(null);
						if (!signedInRef.current) {
							signedInRef.current = true;
							void onSignedIn();
						}
					} else {
						signedInRef.current = false;
					}
					setFailure("");
				} catch (error) {
					if (!silent) setFailure(messageOf(error));
				} finally {
					if (!silent) setLoading(false);
				}
			}, [onSignedIn]);

			React.useEffect(() => {
				void loadStatus();
			}, [loadStatus]);

			React.useEffect(() => {
				if (login === null) return undefined;
				const timer = window.setInterval(() => void loadStatus(true), 2_000);
				return () => window.clearInterval(timer);
			}, [loadStatus, login]);

			const startLogin = async () => {
				if (busy || login !== null) return;
				setBusy(true);
				setFailure("");
				try {
					const value = await authRequest("login", "POST");
					if (value === null || typeof value !== "object") throw new Error("登录响应无效");
					setLogin(value);
					await loadStatus(true);
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setBusy(false);
				}
			};

			const cancelLogin = async () => {
				if (busy) return;
				setBusy(true);
				setFailure("");
				try {
					await authRequest("cancel", "POST");
					setLogin(null);
					await loadStatus(true);
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setBusy(false);
				}
			};

			const logout = async () => {
				if (!window.confirm("退出登录仅影响 DSH Codex 插件账号，不影响系统 Codex CLI。确定继续？")) return;
				setBusy(true);
				setFailure("");
				try {
					await authRequest("logout", "POST");
					setLogin(null);
					signedInRef.current = false;
					await loadStatus(true);
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setBusy(false);
				}
			};

			const verificationUrl = login?.verificationUrl || login?.authUrl;
			return h("section", { className: "dca-auth", "aria-label": "Codex ChatGPT 登录" },
				h("div", { className: "dca-auth-head" },
					h("span", { className: "dca-auth-title" }, "ChatGPT 账号"),
					loading
						? h("span", { className: "dca-auth-state", role: "status" }, "检查中…")
						: account?.signedIn === true
							? h("span", { className: "dca-auth-state", role: "status" }, `已登录${account.planType ? ` · ${account.planType}` : ""}`)
							: h("span", { className: "dca-auth-state", role: "status" }, login === null ? "未登录" : "等待登录"),
				),
				login !== null
					? h("div", { className: "dca-auth-actions" },
						login.userCode ? h("code", { className: "dca-auth-code" }, login.userCode) : null,
						verificationUrl ? h("a", {
							className: "dca-auth-link", href: verificationUrl, target: "_blank", rel: "noreferrer",
						}, "打开验证页面") : null,
						h("button", {
							className: "dca-button", type: "button", disabled: busy, onClick: () => void cancelLogin(),
						}, busy ? "取消中…" : "取消登录"),
					)
					: h("div", { className: "dca-auth-actions" },
						account?.signedIn === true
							? h("button", {
								className: "dca-button", type: "button", disabled: busy, onClick: () => void logout(),
							}, busy ? "退出中…" : "退出登录")
							: h("button", {
								className: "dca-button", type: "button", disabled: busy || loading, onClick: () => void startLogin(),
							}, busy ? "登录中…" : "登录 ChatGPT"),
					),
					h("p", { className: "dca-hint" }, "这是 DSH Codex 插件的独立登录域；升级后首次使用需在此重新登录。"),
					failure.length > 0 ? h("p", { className: "dca-auth-error", role: "status" }, failure) : null,
			);
		}

		function quotaDuration(minutes) {
			if (!Number.isFinite(minutes) || minutes <= 0) return "滚动额度";
			if (minutes % 10_080 === 0) return `${minutes / 10_080} 周额度`;
			if (minutes % 1_440 === 0) return `${minutes / 1_440} 天额度`;
			if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
			return `${minutes} 分钟额度`;
		}

		function quotaReset(timestamp) {
			if (!Number.isFinite(timestamp)) return "";
			return new Intl.DateTimeFormat("zh-CN", {
				month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
			}).format(new Date(timestamp * 1_000));
		}

		function QuotaWindow({ value }) {
			if (value === null) return null;
			const used = Math.max(0, Math.min(100, Number(value.usedPercent) || 0));
			const reset = quotaReset(value.resetsAt);
			return h("div", { className: "dca-quota-window" },
				h("span", null, quotaDuration(value.windowDurationMins)),
				h("span", { className: "dca-quota-bar", title: `已使用 ${used}%` },
					h("span", { className: "dca-quota-used", style: { width: `${used}%` } }),
				),
				h("span", null, `剩余 ${Math.max(0, 100 - used)}%`),
				reset.length === 0 ? null : h("span", { className: "dca-quota-reset" }, `${reset} 重置`),
			);
		}

		function QuotaPanel({ value, loading, failure, onRefresh }) {
			const buckets = Array.isArray(value?.buckets) ? value.buckets : [];
			return h("section", { className: "dca-quota", "aria-label": "Codex 额度" },
				h("div", { className: "dca-quota-head" },
					h("span", { className: "dca-quota-title" }, "额度"),
					h("button", {
					className: "dca-quota-refresh", type: "button", title: "刷新额度",
					"aria-label": "刷新 Codex 额度", disabled: loading, onClick: onRefresh,
				}, h(IconRefreshOutline14, { size: 14 })),
			),
			failure.length > 0
				? h("p", { className: "dca-quota-error", role: "status" }, failure)
				: loading && value === null
					? h("p", { className: "dca-status", role: "status" }, "正在获取额度…")
					: buckets.length === 0
						? h("p", { className: "dca-status" }, "当前账号未返回额度信息")
						: h("div", { className: "dca-quota-buckets" }, buckets.map(bucket => h("div", {
							key: bucket.id, className: "dca-quota-bucket",
						},
							h("div", { className: "dca-quota-name" },
								h("span", null, bucket.name),
								bucket.planType === null ? null : h("span", { className: "dca-quota-plan" }, bucket.planType),
							),
							h("div", { className: "dca-quota-windows" },
								h(QuotaWindow, { value: bucket.primary }),
								h(QuotaWindow, { value: bucket.secondary }),
							),
							bucket.credits?.unlimited === true
								? h("p", { className: "dca-quota-credit" }, "额外用量：无限")
								: bucket.credits?.hasCredits === true
									? h("p", { className: "dca-quota-credit" }, `额外余额：${bucket.credits.balance ?? "可用"}`)
									: null,
						))),
			);
		}

		function cleanModel(model) {
			const id = typeof model.id === "string" ? model.id.trim() : "";
			const name = typeof model.name === "string" ? model.name.trim() : "";
			const contextWindow = Number(model.contextWindow);
			const maxTokens = Number(model.maxTokens);
			const inputModalities = Array.isArray(model.inputModalities)
				? [...new Set(model.inputModalities.map(value => String(value).trim()).filter(value => value === "text" || value === "image"))]
				: typeof model.inputModalities === "string"
					? [...new Set(model.inputModalities.split(",").map(value => value.trim()).filter(value => value === "text" || value === "image"))]
					: [];
			const efforts = Array.isArray(model.efforts)
				? [...new Set(model.efforts.map(value => String(value).trim()).filter(Boolean))]
				: typeof model.efforts === "string"
					? [...new Set(model.efforts.split(",").map(value => value.trim()).filter(Boolean))]
					: [];
			const defaultEffort = typeof model.defaultEffort === "string" ? model.defaultEffort.trim() : "";
			if (defaultEffort.length > 0 && !efforts.includes(defaultEffort)) efforts.push(defaultEffort);
			return {
				id,
				...(name.length > 0 ? { name } : {}),
				...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
				...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
				...(inputModalities.length > 0 ? { inputModalities } : {}),
				...(efforts.length > 0 ? { efforts } : {}),
				...(defaultEffort.length > 0 ? { defaultEffort } : {}),
			};
		}

		function CodexModelsEditor(_, ctx) {
			const api = ctx.get("connection").api;
			const [open, setOpen] = React.useState(false);
			const [draft, setDraft] = React.useState([]);
			const [savedModels, setSavedModels] = React.useState([]);
			const [allowNetworkAccess, setAllowNetworkAccess] = React.useState(false);
			const [savedAllowNetworkAccess, setSavedAllowNetworkAccess] = React.useState(false);
			const [revision, setRevision] = React.useState(0);
			const [writable, setWritable] = React.useState(false);
			const [loading, setLoading] = React.useState(true);
			const [busy, setBusy] = React.useState(false);
			const [failure, setFailure] = React.useState("");
			const [notice, setNotice] = React.useState("");
			const [available, setAvailable] = React.useState([]);
			const [catalogAt, setCatalogAt] = React.useState("");
			const [quota, setQuota] = React.useState(null);
			const [quotaLoading, setQuotaLoading] = React.useState(false);
			const [quotaFailure, setQuotaFailure] = React.useState("");

			const load = React.useCallback(async () => {
				try {
					const response = await api.settings.describe({});
					if (!response.result.ok) throw new Error(response.result.error.message);
					const view = response.result.value.namespaces.find((row) => row.ns === NS);
					if (view === undefined) throw new Error("Codex 设置尚未加载");
					const value = view.value && typeof view.value === "object" ? view.value : {};
					const models = Array.isArray(value.models) ? value.models.map(cleanModel) : [];
					setDraft(models);
					setSavedModels(models);
					setAllowNetworkAccess(value.allowNetworkAccess === true);
					setSavedAllowNetworkAccess(value.allowNetworkAccess === true);
					setRevision(view.revision);
					setWritable(response.result.value.writable === true);
					setFailure("");
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setLoading(false);
				}
			}, [api]);

			const fetchModels = React.useCallback(async () => {
				setBusy(true);
				setFailure("");
				setNotice("");
				try {
					const response = await api.llm.discoverModels({ settingsNs: NS, provider: "codex" });
					if (!response.result.ok) throw new Error(response.result.error.message);
					setAvailable(response.result.value.models.map(cleanModel));
					const now = new Date();
					setCatalogAt(now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
					setNotice(`实时目录 · ${response.result.value.models.length} 个模型`);
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setBusy(false);
				}
			}, [api]);

			const loadQuota = React.useCallback(async () => {
				setQuotaLoading(true);
				setQuotaFailure("");
				try {
					const response = await fetch(`${API_ROOT}/quota`, { method: "GET", cache: "no-store" });
					const body = await response.json();
					if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
					setQuota(body.value);
				} catch (error) {
					setQuotaFailure(messageOf(error));
				} finally {
					setQuotaLoading(false);
				}
			}, []);

			const refreshAfterAuth = React.useCallback(async () => {
				await Promise.allSettled([fetchModels(), loadQuota()]);
			}, [fetchModels, loadQuota]);

			React.useEffect(() => {
				void load();
			}, [load]);

			React.useEffect(() => {
				if (open && quota === null && !quotaLoading && quotaFailure.length === 0) void loadQuota();
			}, [loadQuota, open, quota, quotaFailure, quotaLoading]);

			const patch = (index, field, value) => {
				setDraft((rows) => rows.map((row, at) => at === index
					? { ...row, [field]: value }
					: row));
				setNotice("");
			};

			const addAvailable = (model) => {
				setDraft((rows) => rows.some((row) => row.id === model.id) ? rows : [...rows, model]);
				setNotice("");
			};

			const save = async () => {
				const models = draft.map(cleanModel);
				if (models.some((model) => model.id.length === 0)) {
					setFailure("模型 ID 不能为空");
					return;
				}
				if (new Set(models.map((model) => model.id)).size !== models.length) {
					setFailure("模型 ID 不能重复");
					return;
				}
				setBusy(true);
				setFailure("");
				try {
					const response = await api.settings.mutate({
						ns: NS,
						ops: [
							{ op: "set", path: ["allowNetworkAccess"], value: allowNetworkAccess },
							{ op: "set", path: ["models"], value: models },
						],
						expectedRevision: revision,
					});
					if (!response.result.ok) throw new Error(response.result.error.message);
					setRevision(response.result.value.revision);
					const persistedModels = Array.isArray(response.result.value.value.models)
						? response.result.value.value.models.map(cleanModel)
						: [];
					setDraft(persistedModels);
					setSavedModels(persistedModels);
					const value = response.result.value.value;
					const nextNetwork = value.allowNetworkAccess === true;
					setAllowNetworkAccess(nextNetwork);
					setSavedAllowNetworkAccess(nextNetwork);
					setNotice("已保存");
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setBusy(false);
				}
			};

			const reset = async () => {
				setBusy(true);
				setFailure("");
				try {
					const response = await api.settings.mutate({
						ns: NS,
						ops: [{ op: "unset", path: ["models"] }],
						expectedRevision: revision,
					});
					if (!response.result.ok) throw new Error(response.result.error.message);
					setRevision(response.result.value.revision);
					setDraft([]);
					setSavedModels([]);
					setNotice("已恢复 Codex 实时模型目录");
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setBusy(false);
				}
			};

			const normalizedDraft = draft.map(cleanModel);
			const dirty = allowNetworkAccess !== savedAllowNetworkAccess
				|| JSON.stringify(normalizedDraft) !== JSON.stringify(savedModels.map(cleanModel));

			return h("li", { className: `dca-card ${open ? "dca-card-open" : ""}` },
				h("button", {
					className: "dca-header", type: "button", "aria-expanded": open,
					"aria-label": `${open ? "收起" : "展开"}: Codex`, onClick: () => setOpen(!open),
				},
					h("span", { className: "dca-head-text" },
						h("span", { className: "dca-name" }, "Codex"),
						h("span", { className: "dca-description" }, "订阅模型、上下文窗口与推理强度"),
					),
					dirty ? h("span", { className: "dca-pending" }, "未保存") : null,
					h(IconChevronDownOutline14, { className: `dca-chevron ${open ? "dca-chevron-open" : ""}` }),
				),
				open ? h("div", { className: "dca-body" },
					!writable ? h("p", { className: "dca-readonly", role: "status" }, "当前配置为只读") : null,
					h(AuthPanel, { onSignedIn: refreshAfterAuth }),
					h(QuotaPanel, {
						value: quota, loading: quotaLoading, failure: quotaFailure,
						onRefresh: () => void loadQuota(),
					}),
					h("div", { className: "dca-field" },
						h("label", { className: "dca-toggle" },
							h("input", {
								type: "checkbox", checked: allowNetworkAccess, disabled: busy || !writable,
								onChange: event => { setAllowNetworkAccess(event.target.checked); setNotice(""); },
							}),
							h("span", null, "允许 Codex 访问网络"),
						),
						h("p", { className: "dca-hint" }, "控制 Codex 回合是否可以连接外部网络。"),
					),
					h("div", { className: "dca-field" },
						h("span", { className: "dca-label" }, "模型目录"),
						h("div", { className: "dca-toolbar" },
						h("button", {
							className: "dca-button", type: "button", disabled: busy,
							onClick: () => void fetchModels(),
						}, busy ? "获取中…" : "获取可用模型"),
						h("button", {
							className: "dca-button", type: "button", disabled: busy || !writable,
							onClick: () => setDraft((rows) => [...rows, { id: "", name: "" }]),
						}, "添加模型"),
						h("button", {
							className: "dca-button", type: "button", disabled: busy || !writable,
							onClick: () => void reset(),
						}, "恢复实时目录"),
						h("span", { className: "dca-status" }, loading ? "加载中…" : "推理强度随模型能力显示"),
					),
					available.length === 0 ? null : h("div", { className: "dca-catalog" }, available.map((model) => {
						const added = draft.some((row) => row.id === model.id);
						const label = model.name || model.id;
						return h("button", {
							key: model.id, className: "dca-button dca-candidate", type: "button",
							disabled: !writable || added, title: model.id, onClick: () => addAvailable(model),
						}, added ? `${label} ✓` : `+ ${label}`);
					})),
					draft.length === 0
						? h("p", { className: "dca-empty" }, "当前使用 Codex 实时模型目录")
						: h("div", { className: "dca-models" }, draft.map((model, index) => h("div", {
							key: `${index}:${model.id}`, className: "dca-model",
						},
							h("div", { className: "dca-model-main" },
								h("input", {
									className: "dca-input", value: model.id, placeholder: "Model ID",
									"aria-label": `Model ID ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "id", event.target.value),
								}),
								h("input", {
									className: "dca-input", value: model.name || "", placeholder: "显示名称",
									"aria-label": `显示名称 ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "name", event.target.value),
								}),
								h("button", {
									className: "dca-button dca-remove", type: "button", disabled: busy || !writable,
									title: "移除模型", "aria-label": `移除模型 ${index + 1}`,
									onClick: () => setDraft((rows) => rows.filter((_, at) => at !== index)),
								}, "×"),
							),
							h("div", { className: "dca-model-options" },
								h("input", {
									className: "dca-input", type: "number", min: 1, step: 1,
									value: model.contextWindow || "", placeholder: "上下文窗口",
									"aria-label": `上下文窗口 ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "contextWindow", event.target.value),
								}),
								h("input", {
									className: "dca-input", type: "number", min: 1, step: 1,
									value: model.maxTokens || "", placeholder: "输出默认值（单次请求）",
									"aria-label": `单次请求输出默认值 ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "maxTokens", event.target.value),
								}),
								h("input", {
									className: "dca-input",
									value: Array.isArray(model.inputModalities) ? model.inputModalities.join(", ") : "",
									placeholder: "输入模态 text,image", "aria-label": `输入模态 ${index + 1}`,
									disabled: busy || !writable, onChange: (event) => patch(index, "inputModalities", event.target.value),
								}),
								h("input", {
									className: "dca-input", value: Array.isArray(model.efforts) ? model.efforts.join(", ") : model.efforts || "",
									placeholder: "推理强度，以逗号分隔", "aria-label": `推理强度 ${index + 1}`,
									disabled: busy || !writable, onChange: (event) => patch(index, "efforts", event.target.value),
								}),
								h("input", {
									className: "dca-input", value: model.defaultEffort || "", placeholder: "默认推理强度",
									"aria-label": `默认推理强度 ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "defaultEffort", event.target.value),
								}),
							),
						))),
					),
					h("div", { className: "dca-footer" },
						failure.length > 0
							? h("p", { className: "dca-failed", role: "status" }, failure)
							: notice.length > 0
								? h("p", { className: "dca-footer-status", role: "status", title: catalogAt.length > 0 ? `最近获取 ${catalogAt}` : undefined }, notice)
								: h("span", { className: "dca-footer-status" }),
						h("button", {
							className: "dca-discard", type: "button", disabled: busy || !dirty,
							onClick: () => {
								setDraft(savedModels.map(model => ({ ...model })));
								setWorkingDirectory(savedWorkingDirectory);
								setAllowNetworkAccess(savedAllowNetworkAccess);
								setFailure("");
								setNotice("");
							},
						}, "放弃"),
						h("button", {
							className: "dca-save", type: "button", disabled: busy || !writable || !dirty,
							onClick: () => void save(),
						}, busy ? "保存中…" : "保存"),
					),
				) : null,
			);
		}

		const inject = ["slots", "connection"];
		function apply(ctx) {
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: NS,
			}, (props) => CodexModelsEditor(props, ctx)));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
