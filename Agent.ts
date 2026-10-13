import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";

const ROOT = fs.realpathSync.native(process.cwd());
const MAX_OUTPUTS_CHARS = 20000;
// 压缩阈值。可用 AGENT_MAX_PROMPT_TOKENS 覆盖 —— 设成很大的值就等于关掉压缩，
// 方便做"有压缩 vs 没压缩"的 A/B 对比。
const MAX_PROMPT_TOKENS = Number(process.env.AGENT_MAX_PROMPT_TOKENS || 5000);
const KEEP_ROUNDS = 2;
const KEEP_TOOL_OUTPUTS = 3;   // 压缩时，最近这几条工具输出保持原样，更早的换成占位符
const SQUASHED = "[早期工具输出已省略 —— 需要的话请重新读取]";
const TRIM_IF_SHORTER_THAN = 2000;  // 中间过程短于此就直接裁掉，不值得为它花一次模型调用

// 单次任务最多几轮。可用 AGENT_MAX_STEPS 覆盖 —— 想验证"是不是步数不够用"很方便。
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 30);
// API 重试：网络抖动 / 限流 / 5xx 都算临时故障，退避重试；其余 4xx 直接抛，重试无意义。
const RETRY_MAX = Number(process.env.AGENT_RETRY || 3);
const RETRY_BASE_MS = 500;            // 退避基数：500ms → 1s → 2s
const REQUEST_TIMEOUT_MS = 120000;    // 单次请求超时 2 分钟
const SYSTEM_PROMPT =
    "你是一个运行在用户终端里的编程助手，可以读写文件。" +
    "请用中文回答，简洁准确，不要自称是其他公司的模型。";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// ── 评测模式开关（平时不设这些环境变量，行为和以前完全一样）────────────
// AGENT_AUTO=1    ：自动放行所有工具 —— 评测时没人坐在终端前按 y
// AGENT_QUIET=1   ：不打印调试噪音，stdout 只留最终回答
// AGENT_STATS_OUT ：把本轮统计写成 JSON，交给 run.mjs 收集
const AUTO = process.env.AGENT_AUTO === "1";
const QUIET = process.env.AGENT_QUIET === "1";
const PERMISSIONS = {
    read_file: "allow",
    write_file: AUTO ? "allow" : "ask",
    run_command: AUTO ? "allow" : "ask",
    edit: AUTO ? "allow" : "ask",
};

// 本轮运行要收集的指标
const stats = { turns: 0, prompt_tokens: 0, completion_tokens: 0, reason: "unknown", compactions: [], turns_detail: [] };
// ─────────────────────────────────────────────────────────────────────


function truncate(text, limit = MAX_OUTPUTS_CHARS) {
    if (text.length <= limit) return text;
    return text.slice(0, limit)
        + `\n\n[输出被截断：完整内容共 ${text.length} 字符，这里只显示了前 ${limit} 字符，还剩 ${text.length - limit} 字符未显示]`;
}

// target 是否落在 base 里面（含 base 本身）
function isInside(base, target) {
    const rel = path.relative(base, target);
    if (rel === "") return true;                        // 就是 base 本身
    if (rel === "..") return false;                     // 正正好是上一级
    if (rel.startsWith(".." + path.sep)) return false;  // 往上跑了
    if (path.isAbsolute(rel)) return false;             // 换了盘符，路径压根不相干
    return true;
}

function safePath(p) {
    if (typeof p !== "string" || p.trim() === "") {
        throw new Error("路径不能为空");
    }
    if (p.includes("\0")) {
        throw new Error(`路径含非法字符: ${p}`);
    }

    // ① 先词法归一化：这一步把 ".." 和多余分隔符吃掉
    const abs = path.resolve(ROOT, p);

    // ② 词法检查：挡 "../../../Windows/System32/config"
    if (!isInside(ROOT, abs)) {
        throw new Error(`路径越界: ${p}`);
    }

    // ③ 再按真实路径查一遍：挡符号链接
    //    为什么要解析父目录而不是目标本身：目标可能还不存在（write_file 新建），
    //    而且父目录若是个指向外部的软链，这一步就会露馅。
    const realParent = fs.realpathSync.native(path.dirname(abs));
    const real = path.join(realParent, path.basename(abs));

    if (!isInside(ROOT, real)) {
        throw new Error(`路径越界（符号链接）: ${p}`);
    }

    // ④ 目标本身若存在且是符号链接，一律拒绝。
    //    断链（existsSync 为 false 但确实是个软链）也在这一步被拦下，
    //    否则 write_file 会顺着它写到 ROOT 外面去。
    const st = fs.lstatSync(real, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
        throw new Error(`拒绝操作符号链接: ${p}`);
    }

    return real;
}



const tools = {
    read_file: {
        description: "Read the contents of a file",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "The path to the file"
                }
            },
            required: ["path"]
        },
        handler(args) { return truncate(fs.readFileSync(safePath(args.path), "utf8")); },
        preview(args) { return `读取文件：${args.path}`; },
    },
    write_file: {
        description: "Write content to a file",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "The path to the file"
                },
                content: {
                    type: "string",
                    description: "The content to write to the file"
                }
            },
            required: ["path", "content"]
        },
        handler(args) {
            fs.writeFileSync(safePath(args.path), args.content, "utf8");
            return "文件写入成功";
        },
        preview: (args) => {
            const content = args.content ?? "";
            const head = content.split("\n").slice(0, 5).join("\n");
            return `写入文件：${args.path}\n`
                + `    内容长度：${content.length} 字符、${content.split("\n").length} 行\n`
                + `    开头几行：\n${head}`;
        },

    },
    edit: {
        description: "把文件里的 old_string 替换成 new_string。old_string 必须在文件里【有且仅有一处】，" +
                     "否则会被拒绝 —— 这是为了防止改错地方。要改多行就把整段旧内容原样抄进去。" +
                     "只改一小部分时用它，不要用 write_file 重写整个文件。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "要修改的文件路径" },
                old_string: {
                    type: "string",
                    description: "要被替换掉的原文。必须和文件内容逐字符一致（空格、缩进、换行都要对上），且在文件中只出现一次"
                },
                new_string: { type: "string", description: "替换成的新内容" },
            },
            required: ["path", "old_string", "new_string"]
        },
        handler(args) {
            const file = safePath(args.path);
            const before = fs.readFileSync(file, "utf8");
            const oldStr = args.old_string ?? "";
            const newStr = args.new_string ?? "";

            if (oldStr === "") {
                throw new Error("old_string 不能为空");
            }
            if (oldStr === newStr) {
                return "old_string 和 new_string 一样，文件没有改动";
            }

            // 用 split 数出现次数。别只用 includes —— 那会把"匹配到多处"的情况藏起来，
            // 结果就是悄悄改了错误的那一处。
            const parts = before.split(oldStr);
            const hits = parts.length - 1;

            if (hits === 0) {
                throw new Error("在文件里找不到 old_string。请先 read_file 看一眼原文，"
                    + "注意空白和缩进要逐字符一致（最好连带前后几行一起抄进来）");
            }
            if (hits > 1) {
                throw new Error(`old_string 在文件里出现了 ${hits} 次，无法确定该改哪一处。`
                    + "请多带几行上下文，让它变得唯一");
            }

            fs.writeFileSync(file, parts.join(newStr), "utf8");

            const lines = oldStr.split("\n").length;
            const newLines = newStr.split("\n").length;
            return `已修改 ${args.path}（替换 ${lines} 行 → ${newLines} 行）`;
        },
        preview(args) {
            const oldStr = args.old_string ?? "";
            const newStr = args.new_string ?? "";
            const head = oldStr.split("\n").slice(0, 5).join("\n");
            return `修改文件：${args.path}\n`
                + `    ${oldStr.split("\n").length} 行 → ${newStr.split("\n").length} 行\n`
                + `    将被替换掉的原文开头：\n${head}`;
        },
    },
    run_command: {
        description: "在项目目录下执行 shell 命令。注意：Windows 环境下实际是 cmd.exe，不是 bash；" +
                     "请使用 cmd 语法（dir / del / type / set /a），不要用 ls / rm / echo $((...)) 等 bash 语法。",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "要执行的 shell 命令" }
            },
            required: ["command"]
        },
        handler(args) {
            const r = spawnSync(args.command, {
                shell: true,              // 让 | > && 这些 shell 语法能用
                cwd: ROOT,                // 命令在项目目录下跑
                timeout: 30000,           // ⏱️ 超时保险丝：30 秒
                encoding: "utf8",         // 直接给字符串，不用自己转 Buffer
                maxBuffer: 1024 * 1024,   // 输出上限 1MB，防止内存爆
            });

            // r 里有：r.status（退出码）、r.stdout、r.stderr、r.error（超时等）
            if (r.error) return `命令执行失败：${r.error.message}`;

            const out = [r.stdout, r.stderr].filter(Boolean).join("\n");
            return truncate(`退出码 ${r.status}\n${out || "(无输出)"}`);
        },

        // preview 是 handler 的**兄弟**，不是它的内容 —— 你原来是写在 handler 里面的
        preview(args) { return `⚡ 执行命令：\n${args.command}`; },
    }
};
function runTool(call) {
        try {
            const args = JSON.parse(call.function.arguments);
const tool = tools[call.function.name];          // ← 查 tools
if (!tool) return `错误：未知工具 ${call.function.name}`;
return tool.handler(args);                       // ← 用它的 handler
    } catch (err) {
    return `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
}
}

// 上一次服务器返回的真实 prompt_tokens。用它而不是估算值，
// 因为这是唯一不需要猜的数字，代价是它反映的是"上一轮"的体积（滞后一轮）。
let lastPromptTokens = 0;



// 最近 k 轮的起点：倒数第 k 个 user 消息的下标。轮数不足 k 轮返回 -1。
// trimMessages 和 compact 共用它，免得两处对"轮边界"的理解悄悄跑偏。
function roundStart(messages, k) {
    const userIdx = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "user") userIdx.push(i);
    }
    return userIdx.length <= k ? -1 : userIdx[userIdx.length - k];
}

// 裁掉 K 轮之前的中间过程，保留「系统提示」+「最初的那条用户目标」+「最近 K 轮」。
// 返回新数组；没有可裁的就返回 null。
//
// 注意 messages[0] 是 system 提示、messages[1] 才是用户最初的需求 ——
// 原先这里只留 messages[0] 就说是"保留了用户目标"，其实把真正的目标裁掉了。
function trimMessages(messages) {
    const cut = roundStart(messages, KEEP_ROUNDS);
    // cut <= 2 就没得裁：要么轮次不够，要么裁完等于没裁，要么会把最初的目标一起丢掉
    if (cut <= 2) return null;
    return [messages[0], messages[1], ...messages.slice(cut)];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function chat(messages, useTools = true) {

    if (!QUIET) console.log(messages.length);

    const body = {
        model: "deepseek-flash",
        messages,
        ...(useTools ? {
            tools: Object.entries(tools).map(([name, tool]) => ({
                type: "function",
                function: { name, description: tool.description, parameters: tool.parameters },
            })),
        } : {}),
    };

    // 网络抖动 / 限流 / 服务端 5xx 都是临时故障，退避重试即可；
    // 其余 4xx 是我们自己的请求写错了，重试多少次都一样，直接抛。
    for (let attempt = 1; ; attempt++) {
        let err;
        try {
            const response = await fetch(
                "https://api.deepseek.com/chat/completions",
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),   // 别让一次请求挂死
                }
            );
            const text = await response.text();

            if (response.status === 429 || response.status >= 500) {
                err = new Error(`API 错误 ${response.status}：${text.slice(0, 300)}`);
                err.retryable = true;                    // 限流 / 服务端故障，值得再试
            } else if (!response.ok) {
                err = new Error(`API 错误 ${response.status}：${text.slice(0, 300)}`);
                // 不标 retryable —— 请求本身有问题
            } else {
                const data = JSON.parse(text);
                lastPromptTokens = data.usage.prompt_tokens;   // 记下来，供下一轮判断
                stats.prompt_tokens += data.usage.prompt_tokens;
                stats.completion_tokens += data.usage.completion_tokens;
                if (!QUIET) console.log(" ->prompt_tokens:", lastPromptTokens);
                return data;
            }
        } catch (e) {
            // fetch 自己抛的错（连不上、DNS 失败、超时）也全是临时故障。
            // 统一包成 Error，顺带保住原始错误在 cause 里，方便排查。
            err = new Error(`请求失败：${e?.message ?? e}`);
            err.cause = e;
            err.retryable = true;
        }

        if (!err.retryable || attempt >= RETRY_MAX) throw err;

        const wait = RETRY_BASE_MS * 2 ** (attempt - 1);   // 500ms → 1s → 2s
        if (!QUIET) console.log(`[重试 ${attempt}/${RETRY_MAX - 1}] ${err.message} —— ${wait}ms 后再试`);
        await sleep(wait);
    }
}
// 把一次工具调用压成一行，记进账本。参数里最占地方的是文件内容，
// 那部分记成字数就行 —— 我们要看的是"读了哪个文件、回了多少字符"，
// 不是内容本身。
function briefTool(name, args) {
    // 记账代码在 try/catch 外面 —— 它自己不能抛错，否则会把整轮任务搞崩。
    // 模型传 "null" 或者非对象参数时，args 可能不是对象。
    if (!args || typeof args !== "object") args = {};
    const oneLine = (s) => truncate(String(s ?? ""), 80).replace(/\s+/g, " ");
    if (name === "run_command") return `${name}(${oneLine(args.command)})`;
    if (name === "edit") {
        const from = String(args.old_string ?? "").split("\n").length;
        const to = String(args.new_string ?? "").split("\n").length;
        return `${name}(${args.path} ${from}行→${to}行)`;
    }
    if (name === "write_file") return `${name}(${args.path} ${String(args.content ?? "").length}字符)`;
    if (name === "read_file") return `${name}(${args.path})`;
    return `${name}(${oneLine(JSON.stringify(args))})`;
}

async function runAgent(messages) {
    let step = 0;
    const max_steps = MAX_STEPS;
    let answer = null;
    while (step < max_steps) {
        step++;
        stats.turns++;

        // 本轮账本。只记总数的话，看到"这轮花了 39k、走了 8 步"也不知道多出来的花在哪；
        // 记成每轮一行，才看得出上下文什么时候被压、压完又涨回来多少、有没有重复读同一个文件。
        const rec = { turn: step, ctx: lastPromptTokens, compacted: false, tools: [] };
        stats.turns_detail.push(rec);

        // 每轮开跑之前先量一次上下文。放在循环【里面】而不是循环后 ——
        // 否则一个 10 步的长任务从头到尾都不会压缩，一路涨到爆。
        // 用的是上一轮返回的真实 prompt_tokens，所以判断滞后一轮，够用。
        if (lastPromptTokens > MAX_PROMPT_TOKENS) {
            await compact(messages);
            lastPromptTokens = 0;   // 刚压过，别拿旧数字再判一次（否则每轮都白压一回）
            rec.compacted = true;
        }

        const data = await chat(messages);
        const message = data.choices[0].message;
        messages.push(message);

        if (data.choices[0].finish_reason !== "tool_calls") {
            answer = message.content;
            break;
        }

        for (const tool_call of message.tool_calls) {
            let args;
            try {
                args = JSON.parse(tool_call.function.arguments);
            } catch {
                messages.push({
                    role: "tool",
                    tool_call_id: tool_call.id,
                    content: "参数不是合法 JSON，无法执行",
                });
                continue;                                     // ← 跳过权限检查和执行
            }
            const name = tool_call.function.name;
            const level = PERMISSIONS[name] ?? "deny";

            let result;

            try {
                if (level === "deny") {
                    // PERMISSIONS 里没记录 → 拒绝。是"没有记录"而不是"记成 deny"，
                    // 所以模型自己编出来的工具名也会落到这一支（fail closed）
                    result = `错误：工具 ${name} 未获授权，无法调用。`
                        + `不要重试这个工具，改用已授权的工具，或直接告诉用户你需要什么权限。`;
                } else if (level === "ask") {
                    const ok = await confirmTool(name, args);
                    result = ok
                        ? runTool(tool_call)
                        : `用户拒绝执行 ${name}。不要重试，请问用户希望怎么处理。`;
                } else {
                    result = runTool(tool_call);   // allow：直接执行
                }
            } catch (err) {
                // 兜底：每一条 tool_call 都必须产出一个结果。漏掉一条，
                // 后续请求就会因为"tool_calls 没有配对"被 400 拒掉，整段对话都废了
                result = `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
            }

            // 记下"调了什么、拿回来多少字符" —— 后者才是撑爆上下文的主角
            rec.tools.push(`${briefTool(name, args)} → ${String(result).length}字符`);
            messages.push({ role: "tool", tool_call_id: tool_call.id, content: result });
        }
    }
    if (answer !== null) {
        stats.reason = "done";                 // 模型自己认为答完了
        return answer;
    }
    stats.reason = "max_steps";                // 步数耗尽 —— 评测时要单独归类
    return "（达到最大步数，模型仍在调用工具）";
}

// 把「较早的工具输出」换成占位符，**只动 content**。
// role / tool_call_id / tool_calls 必须原封不动 ——
// 结构一破，后续请求就会因为 tool_calls 配对不上被 400 拒掉，整个任务就废了。
function squashToolOutputs(messages, keep = KEEP_TOOL_OUTPUTS) {
    const idx = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "tool") idx.push(i);
    }
    if (idx.length <= keep) return 0;

    let n = 0;
    for (const i of idx.slice(0, idx.length - keep)) {
        if (messages[i].content !== SQUASHED) {
            messages[i].content = SQUASHED;
            n++;
        }
    }
    return n;
}

// 压缩上下文。四步递进，从最便宜、最不丢信息的做法开始试：
//   ① 省略较早的工具输出 —— 免费，几乎无损（模型想恢复，重读一次就行）
//   ② 再看看还有没有"中间轮次"可处理
//   ③ 中间过程不多 → 直接裁掉 —— 免费，但丢了就没了
//   ④ 中间过程不少 → 叫模型做摘要 —— 花钱，但信息保住了
//
// 注意 ③ 和 ④ 是**对同一件事的两种做法**，不是先后关系：
// 免费的和花钱的做的是同一件事（把中间过程变小），所以按"值不值得花钱"分流。
// 同样是"裁轮次"的两种情况，按中间过程的体量决定是丢还是压。
async function compact(messages) {
    // ① 长任务里撑爆上下文的主因是工具输出（一次 read_file 就几千 token），
    //    而且它们夹在 user 消息之间 —— 光靠裁轮次根本够不着。
    const squashed = squashToolOutputs(messages);
    if (squashed > 0) {
        stats.compactions.push({ stage: "squash_tools", n: squashed });
        if (!QUIET) console.log(`[压缩] 省略了 ${squashed} 条早期工具输出`);
        return;
    }

    // ② 还有没有"中间轮次"？
    const cut = roundStart(messages, KEEP_ROUNDS);
    if (cut <= 2) return;                       // 没有了，认了

    const middle = messages.slice(2, cut);      // 跳过 system 提示和最初的需求
    const chars = middle.reduce((n, m) => n + String(m.content ?? "").length, 0);

    // ③ 中间过程本来就不多 —— 直接裁掉，不值得为它花一次模型调用
    if (chars < TRIM_IF_SHORTER_THAN) {
        const trimmed = trimMessages(messages);
        if (!trimmed) return;
        stats.compactions.push({ stage: "trim_rounds", from: messages.length, to: trimmed.length });
        if (!QUIET) console.log(`[压缩] 裁掉早期轮次：${messages.length} → ${trimmed.length} 条`);
        messages.length = 0;
        messages.push(...trimmed);
        return;
    }

    // ④ 中间过程不少，丢掉可惜 —— 花一次模型调用把它压成摘要
    const tail = messages.slice(cut);           // 最近 K 轮，原样保留
    const goal = messages[1];                   // 最初的需求，逐字保留
    const oldText = truncate(middle.map(m => `${m.role}: ${m.content ?? ""}`).join("\n"));
    if (!oldText.trim()) return;

    const data = await chat(
        [{ role: "user", content: `请把下面的对话记录压缩成 200 字以内的摘要，保留关键事实、结论和未完成的任务：\n\n${oldText}` }],
        false                                   // ← useTools = false
    );
    const summary = data.choices[0].message.content;

    stats.compactions.push({ stage: "summarize", n: middle.length });
    if (!QUIET) console.log(`[压缩] 摘要了 ${middle.length} 条中间过程`);
    // 重建成 [系统提示] + [最初的目标] + [摘要] + [最近 K 轮]
    messages.length = 0;
    messages.push({ role: "system", content: SYSTEM_PROMPT });
    if (goal) messages.push(goal);
    messages.push({ role: "system", content: `以下是之前对话的摘要：\n${summary}` });
    messages.push(...tail);
}

async function confirmTool(name, args) {
    const preview = tools[name].preview(args);
    const a = await rl.question(`${preview}\n\n允许吗？(y/n) `);
    return a.trim().toLowerCase() === "y";
}
function writeStats() {
    const out = process.env.AGENT_STATS_OUT;
    if (!out) return;
    try {
        fs.writeFileSync(out, JSON.stringify(stats, null, 2), "utf8");
    } catch { /* 写不进去就算了，不能因为统计失败把评测搞崩 */ }
}

async function main() {
    const messages = [{ role: "system", content: SYSTEM_PROMPT },];

    // 评测模式：node Agent.ts "任务描述" → 跑一次就退出，不进交互循环
    const oneShot = process.argv.slice(2).join(" ").trim();
    if (oneShot) {
        messages.push({ role: "user", content: oneShot });
        const answer = await runAgent(messages);
        console.log(answer);
        writeStats();
        rl.close();
        return;
    }

    while (true) {
        let q;
        try {
            q = await rl.question("你 > ");
        } catch {
            break;                        // 输入流已关闭 → 正常退出
        }
        if (q.trim() === "exit") break;

        messages.push({ role: "user", content: q });
        const answer = await runAgent(messages);
        console.log("模型 >", answer);
    }

    rl.close();
}


main();