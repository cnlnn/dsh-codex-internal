window.__ModuleLoader__.load({
	id: "@local/dsh-codex-internal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		const NS = "llm-codex-subscription";
		const h = React.createElement;

		const colors = {
			border: "var(--border, rgba(127, 127, 127, 0.28))",
			muted: "var(--text-muted, rgba(127, 127, 127, 0.9))",
			danger: "var(--danger, #c43d3d)",
		};
		const inputStyle = {
			minWidth: 0,
			height: 32,
			padding: "0 9px",
			border: `1px solid ${colors.border}`,
			borderRadius: 6,
			background: "var(--input-bg, transparent)",
			color: "inherit",
			font: "inherit",
			fontSize: 13,
		};
		const buttonStyle = {
			height: 32,
			padding: "0 11px",
			border: `1px solid ${colors.border}`,
			borderRadius: 6,
			background: "var(--button-bg, transparent)",
			color: "inherit",
			font: "inherit",
			fontSize: 13,
			cursor: "pointer",
		};

		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		function cleanModel(model) {
			const id = typeof model.id === "string" ? model.id.trim() : "";
			const name = typeof model.name === "string" ? model.name.trim() : "";
			return { id, ...(name.length > 0 ? { name } : {}) };
		}

		function CodexModelsEditor({ provider }, ctx) {
			const [draft, setDraft] = React.useState([]);
			const [revision, setRevision] = React.useState(0);
			const [writable, setWritable] = React.useState(false);
			const [loading, setLoading] = React.useState(true);
			const [busy, setBusy] = React.useState(false);
			const [failure, setFailure] = React.useState("");
			const [notice, setNotice] = React.useState("");
			const [available, setAvailable] = React.useState([]);

			const load = React.useCallback(async () => {
				try {
					const response = await ctx.remote.settings.describe();
					if (!response.ok) throw new Error(response.error.message);
					const view = response.value.namespaces.find((row) => row.ns === NS);
					if (view === undefined) throw new Error("Codex 设置尚未加载");
					const value = view.value && typeof view.value === "object" ? view.value : {};
					setDraft(Array.isArray(value.models) ? value.models.map(cleanModel) : []);
					setRevision(view.revision);
					setWritable(response.value.writable === true);
					setFailure("");
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setLoading(false);
				}
			}, [ctx]);

			const fetchModels = React.useCallback(async () => {
				setBusy(true);
				setFailure("");
				setNotice("");
				try {
					const response = await ctx.remote.llm.discoverModels(NS, { provider: provider.provider });
					if (!response.ok) throw new Error(response.error.message);
					setAvailable(response.value.map(cleanModel));
					setNotice(`已从 Codex 获取 ${response.value.length} 个可用模型`);
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setBusy(false);
				}
			}, [ctx, provider.provider]);

			React.useEffect(() => {
				void load();
				const dispose = ctx.remote.$on("settings/document-updated", (ns) => {
					if (ns === NS) void load();
				});
				return dispose;
			}, [ctx, load]);

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
					const response = await ctx.remote.settings.mutate(
						NS,
						[{ op: "set", path: ["models"], value: models }],
						revision,
					);
					if (!response.ok) throw new Error(response.error.message);
					setRevision(response.value.revision);
					setDraft(Array.isArray(response.value.value.models)
						? response.value.value.models.map(cleanModel)
						: []);
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
					const response = await ctx.remote.settings.mutate(
						NS,
						[{ op: "unset", path: ["models"] }],
						revision,
					);
					if (!response.ok) throw new Error(response.error.message);
					setRevision(response.value.revision);
					setDraft([]);
					setNotice("已恢复 Codex 实时模型目录");
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setBusy(false);
				}
			};

			return h("details", {
				style: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` },
			},
				h("summary", {
					style: { cursor: "pointer", fontSize: 13, fontWeight: 600, userSelect: "none" },
				}, `模型目录${draft.length > 0 ? ` · ${draft.length} 个自定义` : " · Codex 实时"}`),
				h("div", { style: { display: "grid", gap: 10, marginTop: 12 } },
					h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 } },
						h("button", {
							type: "button",
							style: buttonStyle,
							disabled: busy,
							onClick: () => void fetchModels(),
						}, busy ? "获取中…" : "获取可用模型"),
						h("button", {
							type: "button",
							style: buttonStyle,
							disabled: busy || !writable,
							onClick: () => setDraft((rows) => [...rows, { id: "", name: "" }]),
						}, "添加模型"),
						h("span", { style: { color: colors.muted, fontSize: 12 } },
							loading ? "加载中…" : "推理强度随模型能力显示"),
					),
					available.length === 0 ? null : h("div", {
						style: { display: "flex", flexWrap: "wrap", gap: 6 },
					}, available.map((model) => h("button", {
						key: model.id,
						type: "button",
						style: {
							...buttonStyle,
							height: 28,
							padding: "0 8px",
							fontSize: 12,
							opacity: draft.some((row) => row.id === model.id) ? 0.55 : 1,
						},
						disabled: !writable || draft.some((row) => row.id === model.id),
						title: model.id,
						onClick: () => addAvailable(model),
					}, draft.some((row) => row.id === model.id) ? `${model.name} ✓` : `+ ${model.name}`))),
					draft.length === 0
						? h("div", { style: { color: colors.muted, fontSize: 12 } }, "未添加额外模型")
						: h("div", { style: { display: "grid", gap: 7 } }, draft.map((model, index) => h("div", {
							key: `${index}:${model.id}`,
							style: { display: "grid", gridTemplateColumns: "minmax(150px, 1fr) minmax(130px, 1fr) 32px", gap: 7 },
						},
							h("input", {
								style: inputStyle,
								value: model.id,
								placeholder: "Model ID",
								"aria-label": `Model ID ${index + 1}`,
								disabled: busy || !writable,
								onChange: (event) => patch(index, "id", event.target.value),
							}),
							h("input", {
								style: inputStyle,
								value: model.name || "",
								placeholder: "显示名称",
								"aria-label": `显示名称 ${index + 1}`,
								disabled: busy || !writable,
								onChange: (event) => patch(index, "name", event.target.value),
							}),
							h("button", {
								type: "button",
								style: { ...buttonStyle, width: 32, padding: 0, color: colors.danger },
								disabled: busy || !writable,
								title: "移除模型",
								"aria-label": `移除模型 ${index + 1}`,
								onClick: () => setDraft((rows) => rows.filter((_, at) => at !== index)),
							}, "×"),
						))),
					h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } },
						h("button", {
							type: "button",
							style: { ...buttonStyle, background: "var(--accent, #2f6feb)", color: "white", borderColor: "transparent" },
							disabled: busy || !writable,
							onClick: () => void save(),
						}, "保存"),
						h("button", {
							type: "button",
							style: buttonStyle,
							disabled: busy || !writable,
							onClick: () => void reset(),
						}, "使用实时目录"),
						notice.length === 0 ? null : h("span", { role: "status", style: { color: colors.muted, fontSize: 12 } }, notice),
					),
					failure.length === 0 ? null : h("div", { role: "alert", style: { color: colors.danger, fontSize: 12 } }, failure),
				),
			);
		}

		const inject = ["slots", "remote"];
		function apply(ctx) {
			ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
				name: "settings.models.provider-card",
				key: NS,
			}, (props) => CodexModelsEditor(props, ctx)));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
