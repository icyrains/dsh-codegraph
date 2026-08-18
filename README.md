# dsh-codegraph

让 DSH 会话直接使用 [CodeGraph](https://github.com/colbymchenry/codegraph)
（`@colbymchenry/codegraph`）的预索引代码知识图谱能力。

这是一个**可一键安装的 DSH 插件**（bundle）：它把 `codegraph` CLI 包装成
**13 个模型可见的原生工具**，模型在分析代码时无需 grep/读大量文件，直接按符号、
按区域、按调用链查询索引，并能自举并维护索引（`init`/`index`/`sync`）。

## 提供的工具

| 工具 | 对应 CLI | 用途 |
|---|---|---|
| `codegraph_status` | `status --json` | 索引状态（是否已初始化、版本、文件/节点/边数、待同步变更、建议重建等） |
| `codegraph_init` | `init` | 初始化项目并建立初始索引（`.codegraph/`） |
| `codegraph_index` | `index` | 全量（重）索引；`status` 建议 reindex 时用 |
| `codegraph_sync` | `sync` | 增量同步索引（改代码后调用，让查询反映新代码） |
| `codegraph_uninit` | `uninit -f` | 删除项目索引 |
| `codegraph_query` | `query --json` | 按名称/子串搜索符号，返回结构化 JSON |
| `codegraph_node` | `node` | 单个符号源码 + 调用/被调用轨迹，或带行号读文件 + 依赖 |
| `codegraph_explore` | `explore` | 自然语言探索一块代码区域，直接返回相关文件源码与调用路径 |
| `codegraph_files` | `files --json` | 索引内的项目文件结构 |
| `codegraph_callers` | `callers --json` | 谁调用了某个符号 |
| `codegraph_callees` | `callees --json` | 某个符号调用了什么 |
| `codegraph_impact` | `impact --json` | 改动某个符号会波及哪些代码（重构/改名前用） |
| `codegraph_affected` | `affected --json` | 改动若干源文件后应运行哪些测试文件 |

工具名与 CodeGraph 官方 MCP 工具同名，模型的使用心智与官方文档一致。

## 前置要求

1. 已安装 [DSH](https://github.com/deepseek-ai/deepseek-harness)（本插件为 DSH bundle，随
   DSH web 应用装载）。
2. 已安装 `codegraph` CLI 且其可执行文件在 `PATH` 上（插件在运行时按名字 `codegraph`
   解析可执行文件）：

   ```bash
   npm i -g @colbymchenry/codegraph     # 或按官方 install.sh / npm thin shim 安装
   codegraph --version                  # 确认可用（≥ 1.0）
   ```

## 一键安装

在 DSH 应用的 web profile 中安装（一条命令，无需手动改任何配置文件）：

```bash
dsh plugin --profile web add github:jiangzhenguo/dsh-codegraph
```

做了什么：

- `dsh plugin` 会在 profile 目录里跑 `pnpm add github:jiangzhenguo/dsh-codegraph`；
- 因为本包的 `package.json` 声明了 `dsh.bundle.patch`，DSH 的 plugin 管理器会把它自动
  加入 profile 的 `dsh.profile.bundles` 层栈（`cordis.patch.yml` 里那一条 `insert` 就是它的
  组合层，不需要你手动加）；
- 重启 DSH 应用后，任意会话里模型即可看到 13 个 `codegraph_*` 工具。

> 其他 profile：把 `--profile web` 换成 `--profile tui` 等即可。

### 从 npm 安装（备选）

本包同样可按常规 npm 包发布/安装；若已发布到 npm，用包名替换上面开头的 `github:` 即可。

### 卸载

```bash
dsh plugin --profile web remove dsh-codegraph
```

## 一装上就会优先调用 codegraph 搜代码

插件不只是一个「把工具放出来」的包，它还会**在系统提示词里注入一条高优先级指引**
（`tool:codegraph`，`order: 98`），让模型在搜索/探索代码时**优先用 `codegraph_*` 而不是
grep / glob / read**：

- DSH 内置文件工具的指引集中在 `order 100–104`（`read`=100、`write`=101、`edit`=102、
  `glob`=103、`grep`=104）。本插件的指引放在 **98**，落在它们之前，因此模型先看到
  “优先用 codegraph_* 搜代码”。
- 指引明确告诉模型：先 `codegraph_status`，未初始化则 `codegraph_init`，之后用
  `codegraph_query` / `codegraph_explore` / `codegraph_node` / `codegraph_callers` /
  `codegraph_callees` / `codegraph_impact` / `codegraph_affected` 去做结构化、按依赖图的检索，
  改完代码用 `codegraph_sync`；仅当该路径无索引时才回退到 grep/glob/read。

也就是说：**装上即生效，无需每个会话单独配置**——其他会话也一样会优先走 codegraph
来完成代码搜索。

## 使用流程

1. 在项目目录开一个新的 DSH 会话（cwd = 项目根）。
2. 让模型先跑 `codegraph_status`：未初始化 → 跑 `codegraph_init`。
3. 之后即可用 `codegraph_query` / `codegraph_explore` / `codegraph_node` /
   `codegraph_callers` / `codegraph_callees` / `codegraph_impact` 查代码。
4. 改动代码后用 `codegraph_sync`，需要跑测试时用 `codegraph_affected`。

所有工具默认作用于调用方会话的 cwd；也可显式传 `path` 指向其他项目。

## 为什么会话级 MCP server 不理想（本插件为何存在）

codegraph 的官方 MCP server 在工作区**未建立索引时暴露 0 个工具**（并提示模型
“不要自己索引”）。本插件始终暴露工具——包括模型自举和维护索引所需的
`init`/`index`/`sync`——因此是比 MCP 更顺手的集成方式。

## 测试

`test/run-plugin-test.mjs` 是一个自带真实 `codegraph` CLI + 桩 cordis 服务的运行时测试
harness：加载本插件的 `lib/index.js`，挂载 `tools`/`subprocess` 服务，`apply()` 后逐一调用
13 个工具的真实 `execute`。在装好插件的 profile 里运行：

```bash
CG_PROFILE_NM=<profile>/node_modules node test/run-plugin-test.mjs
```

覆盖：mount 不抛错、**`tool:codegraph` 提示词注入（order 98 < 100，先于 grep/glob/read）**、
13 个工具全部注册、`status`→`init`→`query`→`node`→`files` 主流程、`sync`/`impact`/`affected`、
显式 `path` 覆盖、以及「无 cwd 且无 path 时报错」的错误路径。

> 说明：`callers`/`callees` 在本机 `codegraph@1.0.1` 上返回空数组是 **CLI 侧数据/索引特性**
> （该版本的调用图边未解析到），与插件无关——插件忠实返回 CLI 的真实输出；`impact` 已能
> 返回真实的受影响节点与边。

## 仓库结构

```
├── package.json        # DSH bundle 声明（dsh.bundle.patch）+ @deepseek-ai/dsh-tools peerDependency
├── cordis.patch.yml    # 组合层 patch（把本插件的 node half 插入 host 组合）
├── lib/index.js        # 插件实现：注册 13 个 codegraph_* 工具
├── test/               # 运行时测试 harness（真实 CLI + 桩 cordis 服务）
└── plugin-host.js      # （旧）会话级 host-only 动态版，仅作参考
```

## 许可

MIT
