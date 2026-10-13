# mini-claude-code 学习笔记

> 目标：从零复现一个 mini Claude Code，用于实习面试
> 技术栈：TypeScript（Node 24 原生类型擦除，零运行时依赖）+ DeepSeek API
> 用法：**先自己做下面的自测题，再翻上面的知识块。** 直接重读效果很差，先回忆再对答案才有效。

---

## 一、核心心智模型（只记这一句也够本）

> # 模型没有记忆，是你在替它记。

LLM API 是**无状态（stateless）**的：服务器不是"在跟你聊天"，而是"你发来一堆文字 → 它算完 → 还你一堆文字 → **立刻忘光**"。

由这一句推出的所有结论：

- 它不知道你上一句说了什么——因为**根本没存**
- 所谓"多轮对话"，是**客户端每次把整段历史重新发一遍**伪造出来的
- 所以 `messages` 是**数组**（复数），按时间顺序装着**整段对话**
- 所以模型的回复本身就是一条 `{role:"assistant", content}`，**原样塞回数组**就能续上

这一句也是后面 T4「上下文管理」存在的全部理由。

---

## 二、运行环境

| 概念 | 要点 |
|---|---|
| **cwd** | current working directory。**相对路径的起点**。VS Code 打开文件夹时，内置终端（Ctrl+`）的 cwd = 项目根，所以 `node hello.ts` 不用写全路径 |
| 什么时候会失效 | 你 `cd ..` 之后同一个命令就"找不到文件"——**不是文件没了，是立足点变了** |
| **虚拟环境** | **Node 不需要**。Python 的包在全局 `site-packages`（会互相污染，所以要 venv）；Node 的包在每个项目自己的 `node_modules/`，**这套设计本身就是虚拟环境** |
| **原生跑 TS** | Node 24 直接执行 `.ts`，靠**类型擦除**，不需要 tsx / ts-node / 构建工具 |
| 擦除的代价 | 只擦不转 → `enum` / `namespace` 不能用；`import` 要写全 `.ts` 扩展名 |

---

## 三、TypeScript 的真相

- **类型只活在你写代码的时候**，运行时**被 Node 全部擦掉**。
- 所以：**编辑器标红 ≠ 程序跑不了**。（实测过：`process` 标着红，代码照样跑）
- `ts(2591) 找不到 process` 的原因：**TypeScript 出厂只认识 JavaScript 标准库**，不认识 Node 额外提供的 `process` / `fs` / `path`。
- 解法：装 `@types/node`——**纯类型说明书，不含一行可执行代码**。

---

## 四、一次 HTTP 请求 = 寄一封信

| 部分 | 作用 | 我们的值 |
|---|---|---|
| **URL** | 收件地址 | `https://api.deepseek.com/chat/completions` |
| **method** | 取(GET) / 交(POST) | `POST` |
| **headers** | 信封备注 | `Authorization` + `Content-Type` |
| **body** | 信纸 | `JSON.stringify({...})` |

三个易错点：

1. **`Bearer` 后面必须有一个空格**：`Authorization: Bearer <key>`
2. **`GET` 不允许带 body**（撞过这个错）
3. **网络只能传文本** → `JSON.stringify()` 把对象变字符串发出去；`response.json()` 把字符串变回对象

### `await` 是什么

网络请求要花时间。`await` = **"这里要等一个异步结果，等的时候别把程序堵死"**。
只能写在 `async` 函数里 → 所以代码包在 `async function main()` 里。

---

## 五、LLM API 协议

### 消息的形状

每条消息 = `{ role, content }`：**谁在说话** + **说了什么**

| role | 谁 | 什么时候用 |
|---|---|---|
| `system` | 系统 | **给模型定规矩**（人设、语言、约束），通常放数组第一条 |
| `user` | 用户 | 你或你的程序说的话 |
| `assistant` | 助手 | **模型说过的话**——重播历史时用 |

### 响应里要认得的字段

| 字段 | 含义 | 为什么重要 |
|---|---|---|
| `choices[0].message.content` | **最终答案** | 你要打印的 |
| `choices[0].message.reasoning_content` | 模型的**思考过程** | 和答案分开存，调试时有用 |
| `choices[0].finish_reason` | `stop` = 正常说完；`length` = 被截断 | 判断回答是否完整 |
| `usage.prompt_tokens` | 发过去的 token | **计费依据** |
| `usage.completion_tokens` | 生成出来的 token | **计费依据** |
| `usage.total_tokens` | 合计 | 评测统计指标 |
| `prompt_cache_hit_tokens` | 缓存命中的部分 | **更便宜、更快** |

### 多轮对话的完整机制

```
第1轮：发 [system, user]                                  → 回 assistant①
第2轮：发 [system, user, assistant①, user②]               → 回 assistant②
第3轮：发 [system, user, assistant①, user②, assistant②, user③] → ...
```

**关键**：如果你不把 `assistant①` 放回去，模型就**不知道它刚才说过什么**。

---

## 六、安全

### 密钥泄露有三条渠道，`.env` 只堵住一条

| 渠道 | `.env` + `.gitignore` 能防吗 |
|---|---|
| 写死在源码 → git 提交 → 公开仓库 | ✅ 能防 |
| **贴进聊天 / issue / 文档 / 截图** | ❌ 防不了 |
| **打印进日志 / 终端截图** | ❌ 防不了 |

### 原则

- **轮换成本为 0 时，永远选择轮换。**（已实践过）
- **URL / 密钥 / 包名：手打或从官方文档复制，绝不接受自动补全。**
- **typosquatting（域名仿冒）**：`api.deepseek.ai` vs `api.deepseek.com` 这种一字之差，专门钓 API key。
- **供应链攻击**：npm 包名同理，`cross-env` 装成 `crossenv` 就是恶意包。
- 删掉文件 ≠ 从 git 历史里删掉（要 `git filter-repo` 之类）。

---

## 七、调试方法论（比任何 API 知识都值钱）

1. **先分清谁在报错**

   | | 谁在报 | 请求出去了吗 | 例子 |
   |---|---|---|---|
   | **本地错误** | Node | ❌ 根本没出门 | `GET cannot have body` |
   | **服务端错误** | DeepSeek 服务器 | ✅ 到了，读完才拒绝 | `missing field 'messages'` |

   两类错误的排查方向完全不同。**收到服务端错误反而说明你的网络、URL、鉴权、JSON 格式都对了。**

2. **逐词翻译报错**——它经常用人话把答案告诉你了。
3. **善用定位信息**：`at line 1 column 137` 是精确的字符位置。
4. **一次只改一个变量**——否则报错时你不知道是谁干的。**最小可用优先。**
5. **报错是一层层剥的**——修掉外层，内层才露出来。这是所有人的正常流程。
6. **⚠️ `console.log` 会骗你**：深层对象显示成 `[Object]`（不是"里面是对象"，是**被折叠了**）。
   解法：`console.dir(data, {depth: null})` 或 `console.log(JSON.stringify(data, null, 2))`

---

## 八、心态

> # 证据 > 权威

老师说过「`deepseek-flash` 不是真实模型」——**结果老师错了**。跑一遍，服务器用 `finish_reason: stop` 和真实的 `reasoning_tokens` 证明了它可用。

同样的怀疑适用于：AI 补全、文档、博客、以及**任何说得很有信心的人**。

**唯一可靠的依据是证据。**

---

## 九、踩坑记录

| 坑 | 教训 |
|---|---|
| 编辑器补全给出 `api.deepseek.ai` | typosquatting。URL 必须手打或从官方文档复制 |
| `method:"get"` 却带了 body | HTTP 方法语义；Node 在本地就拦住了 |
| `message` 写成单数、值是字符串 | 无状态 → 必须传完整历史 → 必须叫 `messages` 且是数组 |
| 打印时只看到 `[Object]` | `console.log` 会折叠深层对象 |
| 真 key 贴进了对话 | 密钥有三条泄露渠道；成本为 0 时立刻轮换 |

---

## 十、自测题

**合上上面，自己答。答不出来写"不会"——那才是你真正要补的地方。**

1. 为什么 `node hello.ts` 可以不写全路径？什么情况下就必须写了？
2. 这个项目要不要建虚拟环境？为什么？（对比 Python 的经验答）
3. VS Code 里 `process` 标红，程序还能跑吗？为什么？
4. 一个 HTTP 请求有哪四个部分？分别什么作用？
5. 为什么 GET 不能带 body？我们该用什么方法？
6. `JSON.stringify` 和 `response.json()` 分别干什么？为什么需要它们？
7. 为什么字段叫 `messages` 而不是 `message`？为什么必须是数组？
8. **模型是怎么"记住"上一轮对话的？用一句话说清机制。**
9. `role` 有哪三个值？各自什么时候用？
10. `usage` 里哪几个数字直接跟你的钱包相关？
11. `GET cannot have body` 和 `missing field messages` 这两个错误的**性质**有什么不同？
12. `.env` 能防住哪一类泄露？防不住哪一类？

<details>
<summary><b>参考答案（先自己答完再点开）</b></summary>

1. 因为终端的 cwd 就是项目根目录，相对路径从 cwd 出发解析。当你 `cd` 到别的目录后，就必须写全路径（或先 cd 回来）。
2. **不需要**。Python 的包全局共享、会互相污染所以需要 venv；Node 的依赖装在项目自己的 `node_modules/`，**天生按项目隔离**——这套设计本身就是虚拟环境。
3. **能跑**。红线是 VS Code 的 TypeScript 语言服务做的**静态检查**；`node` 执行时会把类型**全部擦掉**。两件事互不影响。
4. URL（发到哪）、method（干什么）、headers（附加说明：你是谁 + 内容格式）、body（内容）。
5. 因为 GET 的语义是"**取**"（幂等、无副作用），没有内容要提交；只有 POST 这类"**交**"的方法才允许带 body。
6. `JSON.stringify` 把 JS 对象转成**字符串**（因为网络只能传文本）；`response.json()` 把收到的 JSON **字符串解析回对象**。
7. 因为 API **无状态**，每次请求都必须把**整段对话历史**重新发过去。历史是多条消息、有先后顺序 → 必须用数组。
8. **每次请求都把整段历史重发一遍**；模型回复本身就是 `{role:"assistant", content}`，把它**原样 append 回数组末尾**，下一轮带上，就"记得"了。
9. `system` = 给模型定规矩（人设、约束）；`user` = 用户/程序说的话；`assistant` = **模型说过的话**，重播历史时用。
10. `usage.prompt_tokens`（发过去的）和 `usage.completion_tokens`（生成的）——两者共同决定费用。
11. `GET cannot have body` 是**本地错误**，Node 在请求发出**之前**就拦住了，请求根本没出门；`missing field messages` 是**服务端错误**，请求**成功到达**服务器、被解析后才被拒绝。
12. 能防"**写死在源码里被 git 提交到公开仓库**"；防不住"**主动贴给别人**"（聊天、issue、截图）和"**被打印进日志**"。

</details>

---

## 十一、进度

### 已完成

- [x] 环境确认（Node v24.11.1，原生跑 TS）
- [x] 理解 cwd / 相对路径
- [x] 环境变量与 `.env`（`--env-file`）
- [x] 手写 `fetch` 发出第一个真实 API 请求
- [x] 读懂完整响应结构（`JSON.stringify(data, null, 2)`）
- [x] 只打印 `data.choices[0].message.content`
- [x] **🎉 亲手实现多轮对话**（`messages.push(模型的回复)`）
  - 证据：第二次问"那它有多少人口"，模型答的是**巴黎**的人口——而第二轮提问里没有"巴黎"二字
  - 这就是「模型没有记忆，是你在替它记」的落地
- [x] **T1 抽出 `chat(messages)` 函数** —— 去掉重复的 12 行 fetch
- [x] **🎉🎉 T2 手写 tool calling 循环**（项目的心脏）
  - 三个里程碑：① 模型第一次开口要工具（`tool_calls` / `finish_reason: "tool_calls"`）
    ② 你的代码真的执行工具（`JSON.parse(arguments)` → `fs.readFileSync`）
    ③ 包进 `while` 循环 + 最大步数保险丝
  - **证据**：不需要工具的问题 → 调用模型 **1 次**；需要工具的问题 → **2 次**
  - 这就是「模型是大脑，代码是手」的落地

### 关键机制备忘（T2 学到的）

| 机制 | 说明 |
|---|---|
| `arguments` 是**字符串** | 必须 `JSON.parse()` 才能当对象用 |
| 回喂要 push **两条** | ① assistant 消息（含 `tool_calls`）② `role: "tool"` 的结果 |
| `tool_call_id` | 让结果找到"自己的问题"；一次可并行多个工具调用 |
| `finish_reason` | `"stop"` → 结束；`"tool_calls"` → 继续循环。**它是循环的开关** |
| 循环必须有**上限** | 否则模型一直要工具 → 无限烧钱（面试必问：怎么防止 agent 失控） |
| `messages` 结尾 | 通常是 `user` 或 `tool`。**以 `assistant` 结尾 → 模型会自言自语** |
| `prompt_cache_hit_tokens` | 前缀不变才命中。**把不变的放前面**（tools 在前，messages 在后） |
| 工具定义**要花 token** | 加 tools 后 prompt_tokens 从 37 → 311 |

### T0 遗留（可选，不阻塞）

- [ ] 小实验：加一条 `system` 消息说「你只能用中文回答」，观察行为变化
- [ ] **对照实验**：注释掉 `messages.push(...)` 再跑，确认模型失忆 → 证明因果

### 风险项

- [x] `.gitignore` 已建（挡住 `.env` / `node_modules`）——**密钥防线第一条**
- [ ] 目录里有个叫 `1` 的条目，若不是有意创建可以删掉
- [ ] `write_file` 是**无条件覆盖**（`writeFileSync`），没有"已存在则询问"——T5 要处理

### 后续路线

- [x] **T1** 抽出 `chat()` 函数 + 多轮历史
- [x] **T2** 手写 tool calling 循环 ⭐ 项目的心脏
- [x] **T3** 工具集（核心部分已完成）
  - [x] T3.1 加 `write_file`，把「工具分发」重构成注册表（`toolHandlers`）
  - [x] T3.1b 单一数据源：`tools` 对象 → `Object.entries().map()` 生成 API schema
  - [x] **T3.3 路径沙箱 `safePath()`** —— 四层纵深防御
    - 输入校验（空 / `\0` 空字节注入）
    - `path.resolve` 词法归一化 → `isInside` 检查（含跨盘符）
    - `realpathSync(dirname)` 真实路径检查（挡软链，且目标可不存在）
    - `lstatSync` 拒绝符号链接（含**断链**）
    - **实证**：模型尝试写 `C:/Users/Public/Desktop` → 被拒「路径越界」✅
  - [x] **T3.3b 输出截断** —— 截在「返回给模型之前」，且**带上完整长度**（模型才知道缺了多少）
  - [x] **T3.3c 工具异常隔离** —— `JSON.parse` + 执行全在 `try` 内，故障当成结果喂回模型
  - [ ] T3.2 工具描述的手艺（目前描述够用，后面专门练）
  - [ ] T3.4 `bash` 工具（超时、危险命令）—— 可推迟
- [x] **T4** 上下文预算与裁剪
  - [x] T4.1 **先度量**：给 `chat()` 加 `prompt_tokens` 日志，观察真实增长曲线
    - 无压缩时：388 → 13761（5 轮，一路涨）
    - 关键发现：**工具结果进来时暴涨**（+1928/+3090），普通对话只小涨（+270/+139）
  - [x] T4.2a 滑动窗口裁剪 `trimMessages` + `roundStart`
    - 只在 `user` 消息处下刀（保证 `tool_calls`/`tool` 配对不被打散）
    - 踩过的坑：锚点用「第 2 个 user」会**用一次就永久失效** → 改用「最近 K 轮」
  - [x] T4.2b **compaction 压缩**（正解，取代粗暴丢弃）
    - 老对话 → 让模型总结成摘要 → 用 `[system: 摘要] + [最近 K 轮]` 替换
    - 压缩调用**不带工具**（否则模型会跑去读文件而不是总结）
    - **实证**：压缩前峰值 13761 → 压缩后稳定在 4100-4300，且任务全部答对
  - 已知遗留问题：
    - 压缩**碰不到最近 K 轮的巨型工具结果** → 需要"压两轮"才达标
    - **反复压缩 = 摘要的摘要**，信息逐层衰减（所有 compaction 系统的通病）
    - `truncate` 是 `readFileSync` **之后**才截断 → 超大文件仍会先进内存
- [x] **T5 权限系统 allow / ask / deny**
  - `PERMISSIONS = { read_file: "allow", write_file: "ask" }`，未登记的走 `?? "deny"`（**fail closed**）
  - 权限判断放在 `runAgent`（决策层），`runTool` 保持纯粹（执行层）——**策略 vs 机制分离**
  - **`preview(args)` 放进 `tools` 里**：让每个工具自己决定怎么向用户交代
    - `read_file` → 路径
    - `write_file` → 路径 + 内容长度 + 开头几行（**三者缺一，判断就不完整**）
    - 反面教材：一刀切 `truncate(JSON.stringify(args), 200)` —— **可能把 bash 命令的后半截（真正的危险）切掉**
  - **实证**：按 `n` 拒绝后，模型**不重试、不绕过**，主动列出替代方案并等用户决定
    - 原因之一：拒绝信息里写了「**不要重试，请问用户希望怎么处理**」——**工具结果就是给模型的指令**
- [x] **T6.1 终端交互**：`node:readline/promises` 反复读取用户输入，`exit` 退出
- [x] **T7.1 系统提示词**：加 `SYSTEM_PROMPT`，模型不再自称 Claude
  - 之前它说"我是 Claude，由 Anthropic 开发"——**它不知道自己在哪，只是在续写训练数据里最常见的"助手自我认知"**
  - 报警点：**它对"我是谁"斩钉截铁地错，对"版本号"却诚实地说不确定**——错误和谨慎混在一起，最难识别

### 🔒 安全发现：Windows 目录联接绕过沙箱（对抗性测试）

**这是整个项目最硬的素材。**

| | |
|---|---|
| **攻击** | 在 ROOT 内建 `mklink /J OutsideLink <外部目录>`，让 agent 读 `OutsideLink/secret.txt` |
| **结果** | ❌ **沙箱被绕过**，读到了 ROOT 外的文件 |
| **根因** | Node 的 `fs.realpathSync`（JS 实现）**逐段走路径 + 用 `readlink` 解析链接**。而 **junction 的 `readlink` 抛 `EINVAL`** → 被当成普通目录 → 不解析。同时 `lstat().isSymbolicLink()` 对 junction **返回 `false`**（junction 是 `IO_REPARSE_TAG_MOUNT_POINT`，符号链接才是 `IO_REPARSE_TAG_SYMLINK`）→ **第 ③④ 层双重失明** |
| **修复** | `fs.realpathSync` → **`fs.realpathSync.native`**（走系统原生 `GetFinalPathNameByHandle`，认得 junction） |
| **验证** | 重跑同一攻击 → `工具执行失败：路径越界（符号链接）` ✅ |

**排错过程中试过但不行的方案**：`lstat.ino` vs `stat.ino` 对比（对 junction **完全相同**）。

**已知残余缺口**：**硬链接**（`mklink /H`）——硬链接是"同一文件的两个名字"，没有目标路径可解析，`realpath` 无能为力。

**一句话（面试用）**：
> "我做了对抗性测试，发现 Node 的 `realpathSync` 在 Windows 上不解析 junction，沙箱被绕过。定位到根因是它用 `readlink` 逐段解析而 junction 会抛 EINVAL，改用 `realpathSync.native` 后重跑同一攻击被成功拦截。"

- [ ] **T3.4 `bash` 工具** ← **当前**
  - ⚠️ bash 能执行的命令是**无限的**，`safePath` 完全管不住 → **权限系统是唯一的守门人**
  - 需要：超时、输出截断、`preview` **完整显示命令**（绝不截断）
- [ ] T6.2 流式输出（SSE）
- [ ] T7.2 会话持久化 / 恢复
- [ ] T8 评测集
- [ ] T9 README + 架构图 + demo

### 待修的 bug

- [ ] `ERR_USE_AFTER_CLOSE`：输入流结束（管道 / Ctrl+D）时 `rl.question()` 抛错。把提问包进 `try/catch`，catch 里 `break`
- [ ] `PERMISSIONS` 里没有的工具走 deny —— 已完成 ✅
- [ ] 目录里那个叫 `1` 的条目，若不是有意创建可以删掉

---

## 十二、面试会被追着问的

1. 怎么防止 agent 无限循环 / 失控？刹车在哪一层？
2. 上下文塞不下了怎么办？丢了什么？怎么保证不丢关键信息？
3. 工具报错后，怎么让模型自己修好而不是反复撞墙？
4. 怎么保证它不会删掉用户的文件？权限判断放在哪？
5. 你怎么证明它"有效"？有没有量化指标？
6. 如果让你支持 100 个工具，schema 会怎么组织？
