window.__ModuleLoader__.load({
	id: "@local/dsh-codex-internal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		const { IconChevronDownOutline14 } = require("@deepseek-ai/dsh-client-ui-primitives");
		const NS = "llm-codex-subscription";
		const h = React.createElement;

		const css = `
.dci-card{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);list-style:none;transition:border-color .16s,background .16s}
.dci-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dci-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dci-header{box-sizing:border-box;appearance:none;display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;border:0;border-radius:12px;color:inherit;background:transparent;text-align:left;cursor:pointer;font:inherit}
.dci-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dci-head-text{display:flex;min-width:0;flex:1;flex-direction:column;gap:4px}
.dci-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dci-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dci-pending{flex:none;padding:1px 8px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.dci-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.dci-chevron-open{transform:rotate(180deg)}
.dci-body{margin:0 16px;padding-bottom:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.dci-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 0}
.dci-catalog{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:12px}
.dci-models{display:grid}
.dci-model{display:grid;gap:8px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.dci-model:first-child{border-top:0}
.dci-model-main{display:grid;grid-template-columns:minmax(150px,1fr) minmax(130px,1fr) 34px;gap:8px}
.dci-model-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.dci-button{box-sizing:border-box;appearance:none;min-height:32px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.dci-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dci-button:disabled{cursor:default;opacity:.4}
.dci-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dci-candidate{min-height:28px;padding:3px 9px;font-size:12px}
.dci-remove{width:34px;padding:0;color:var(--dsw-alias-label-error)}
.dci-input{box-sizing:border-box;min-width:0;height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5}
.dci-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dci-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dci-status,.dci-readonly,.dci-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dci-readonly{margin-top:12px}
.dci-empty{padding:4px 0 12px}
.dci-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.dci-failed,.dci-footer-status{min-width:0;flex:1;margin:0;color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5}
.dci-footer-status{color:var(--dsw-alias-label-tertiary)}
.dci-discard,.dci-save{appearance:none;padding:5px 14px;border:1px solid transparent;border-radius:8px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.dci-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}
.dci-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dci-save{color:var(--dsw-alias-bg-layer-3);background:var(--dsw-alias-label-primary)}
.dci-discard:disabled,.dci-save:disabled{cursor:default;opacity:.4}
.dci-discard:focus-visible,.dci-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@media(max-width:640px){.dci-model-main{grid-template-columns:minmax(0,1fr) 34px}.dci-model-main .dci-input:nth-child(2){grid-column:1/-1;grid-row:2}.dci-remove{grid-column:2;grid-row:1}.dci-model-options{grid-template-columns:minmax(0,1fr)}}
`;
		if (document.querySelector("style[data-dsh-codex-internal]") === null) {
			const style = document.createElement("style");
			style.dataset.dshCodexInternal = "";
			style.textContent = css;
			document.head.appendChild(style);
		}

		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		function cleanModel(model) {
			const id = typeof model.id === "string" ? model.id.trim() : "";
			const name = typeof model.name === "string" ? model.name.trim() : "";
			const contextWindow = Number(model.contextWindow);
			const maxTokens = Number(model.maxTokens);
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
				...(efforts.length > 0 ? { efforts } : {}),
				...(defaultEffort.length > 0 ? { defaultEffort } : {}),
			};
		}

		function CodexModelsEditor(_, ctx) {
			const api = ctx.get("connection").api;
			const [open, setOpen] = React.useState(false);
			const [draft, setDraft] = React.useState([]);
			const [savedModels, setSavedModels] = React.useState([]);
			const [revision, setRevision] = React.useState(0);
			const [writable, setWritable] = React.useState(false);
			const [loading, setLoading] = React.useState(true);
			const [busy, setBusy] = React.useState(false);
			const [failure, setFailure] = React.useState("");
			const [notice, setNotice] = React.useState("");
			const [available, setAvailable] = React.useState([]);
			const [catalogAt, setCatalogAt] = React.useState("");

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

			React.useEffect(() => {
				void load();
			}, [load]);

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
						ops: [{ op: "set", path: ["models"], value: models }],
						expectedRevision: revision,
					});
					if (!response.result.ok) throw new Error(response.result.error.message);
					setRevision(response.result.value.revision);
					const models = Array.isArray(response.result.value.value.models)
						? response.result.value.value.models.map(cleanModel)
						: [];
					setDraft(models);
					setSavedModels(models);
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
			const dirty = JSON.stringify(normalizedDraft) !== JSON.stringify(savedModels.map(cleanModel));

			return h("li", { className: `dci-card ${open ? "dci-card-open" : ""}` },
				h("button", {
					className: "dci-header", type: "button", "aria-expanded": open,
					"aria-label": `${open ? "收起" : "展开"}: Codex`, onClick: () => setOpen(!open),
				},
					h("span", { className: "dci-head-text" },
						h("span", { className: "dci-name" }, "Codex"),
						h("span", { className: "dci-description" }, "订阅模型、上下文窗口与推理强度"),
					),
					dirty ? h("span", { className: "dci-pending" }, "未保存") : null,
					h(IconChevronDownOutline14, { className: `dci-chevron ${open ? "dci-chevron-open" : ""}` }),
				),
				open ? h("div", { className: "dci-body" },
					!writable ? h("p", { className: "dci-readonly", role: "status" }, "当前配置为只读") : null,
					h("div", { className: "dci-toolbar" },
						h("button", {
							className: "dci-button", type: "button", disabled: busy,
							onClick: () => void fetchModels(),
						}, busy ? "获取中…" : "获取可用模型"),
						h("button", {
							className: "dci-button", type: "button", disabled: busy || !writable,
							onClick: () => setDraft((rows) => [...rows, { id: "", name: "" }]),
						}, "添加模型"),
						h("button", {
							className: "dci-button", type: "button", disabled: busy || !writable,
							onClick: () => void reset(),
						}, "恢复实时目录"),
						h("span", { className: "dci-status" }, loading ? "加载中…" : "推理强度随模型能力显示"),
					),
					available.length === 0 ? null : h("div", { className: "dci-catalog" }, available.map((model) => {
						const added = draft.some((row) => row.id === model.id);
						const label = model.name || model.id;
						return h("button", {
							key: model.id, className: "dci-button dci-candidate", type: "button",
							disabled: !writable || added, title: model.id, onClick: () => addAvailable(model),
						}, added ? `${label} ✓` : `+ ${label}`);
					})),
					draft.length === 0
						? h("p", { className: "dci-empty" }, "当前使用 Codex 实时模型目录")
						: h("div", { className: "dci-models" }, draft.map((model, index) => h("div", {
							key: `${index}:${model.id}`, className: "dci-model",
						},
							h("div", { className: "dci-model-main" },
								h("input", {
									className: "dci-input", value: model.id, placeholder: "Model ID",
									"aria-label": `Model ID ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "id", event.target.value),
								}),
								h("input", {
									className: "dci-input", value: model.name || "", placeholder: "显示名称",
									"aria-label": `显示名称 ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "name", event.target.value),
								}),
								h("button", {
									className: "dci-button dci-remove", type: "button", disabled: busy || !writable,
									title: "移除模型", "aria-label": `移除模型 ${index + 1}`,
									onClick: () => setDraft((rows) => rows.filter((_, at) => at !== index)),
								}, "×"),
							),
							h("div", { className: "dci-model-options" },
								h("input", {
									className: "dci-input", type: "number", min: 1, step: 1,
									value: model.contextWindow || "", placeholder: "上下文窗口",
									"aria-label": `上下文窗口 ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "contextWindow", event.target.value),
								}),
								h("input", {
									className: "dci-input", type: "number", min: 1, step: 1,
									value: model.maxTokens || "", placeholder: "最大输出",
									"aria-label": `最大输出 ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "maxTokens", event.target.value),
								}),
								h("input", {
									className: "dci-input", value: Array.isArray(model.efforts) ? model.efforts.join(", ") : model.efforts || "",
									placeholder: "推理强度，以逗号分隔", "aria-label": `推理强度 ${index + 1}`,
									disabled: busy || !writable, onChange: (event) => patch(index, "efforts", event.target.value),
								}),
								h("input", {
									className: "dci-input", value: model.defaultEffort || "", placeholder: "默认推理强度",
									"aria-label": `默认推理强度 ${index + 1}`, disabled: busy || !writable,
									onChange: (event) => patch(index, "defaultEffort", event.target.value),
								}),
							),
						))),
					h("div", { className: "dci-footer" },
						failure.length > 0
							? h("p", { className: "dci-failed", role: "status" }, failure)
							: notice.length > 0
								? h("p", { className: "dci-footer-status", role: "status", title: catalogAt.length > 0 ? `最近获取 ${catalogAt}` : undefined }, notice)
								: h("span", { className: "dci-footer-status" }),
						h("button", {
							className: "dci-discard", type: "button", disabled: busy || !dirty,
							onClick: () => { setDraft(savedModels.map(model => ({ ...model }))); setFailure(""); setNotice(""); },
						}, "放弃"),
						h("button", {
							className: "dci-save", type: "button", disabled: busy || !writable || !dirty,
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
