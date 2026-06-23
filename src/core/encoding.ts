// 子进程输出编码处理
//
// # 文件说明书
//
// ## 核心功能
// 把子进程 stdout/stderr 的 Buffer 解码成字符串。Windows 原生命令
// (cmd.exe / wmic / 中文输出的 exe)默认吐 GBK(CP936);若一律按 UTF-8
// 解码,中文会乱码。这里用「先 fatal UTF-8 校验,失败回退 GBK」的策略
// 自动处理,对 UTF-8/ASCII 输出零开销直通。
//
// ## 输入
// - Buffer(execFile encoding:"buffer" / spawn 的 data 事件累积)
//
// ## 输出
// - 解码后的字符串
//
// ## 定位
// 核心工具,被 Shell 工具(bash.ts)、后台任务(subagent-delegator /
// subagent-delegation)、设备信息(device-context)共用。
//
// ## 维护规则
// - 仅在 UTF-8 解码失败时才回退 GBK,保证 Linux/macOS(UTF-8)直通。
// - 多字节文本必须先把所有 chunk 累积成完整 Buffer 再调用本函数,
//   否则 chunk 边界会切断 GBK/UTF-8 多字节字符。

import iconv from "iconv-lite";

/**
 * 把子进程输出的 Buffer 解码成字符串。优先 UTF-8(用 fatal 模式严格校验);
 * 若含非法 UTF-8 序列(典型为 Windows 原生命令的 GBK 输出),回退按 GBK 解。
 * 空 Buffer 返回空串。对纯 ASCII / 合法 UTF-8 输出走 fast path,无额外开销。
 */
export function decodeShellBuffer(buf: Buffer): string {
	if (buf.length === 0) return "";
	try {
		// fatal:true → 遇到非法 UTF-8 序列抛出,借此判定「不是 UTF-8」。
		return new TextDecoder("utf8", { fatal: true }).decode(buf);
	} catch {
		return iconv.decode(buf, "gbk");
	}
}

/**
 * 一次性解码 execFile(encoding:"buffer")返回的 { stdout, stderr }。
 * 两个字段在 encoding:"buffer" 下都是 Buffer;成功路径与 err 对象通用。
 */
export function decodeExecBuffers(r: { stdout?: Buffer; stderr?: Buffer }): {
	stdout: string;
	stderr: string;
} {
	return {
		stdout: r.stdout ? decodeShellBuffer(r.stdout) : "",
		stderr: r.stderr ? decodeShellBuffer(r.stderr) : "",
	};
}
