/**
 * codearts-bridge 结构化错误（T1-03）。
 *
 * 设计（任务书接口 + 全局约束"禁静默兜底"）：
 * - 一切需要向调用方报告的失败，统一抛 `BridgeError`：
 *   `code` 为 UPPER_SNAKE 稳定错误码（调用方/工具层据此分支），`remediation`
 *   为中文修复指引（用户可见），`cause` 保留底层错误便于根因定位。
 * - `code` 保持开放 string（不做封闭联合）：后续任务（T1-04 repair /
 *   T1-05 upgrade / T3-* 目标引擎）按同一约定增列错误码，避免频繁改动本类型。
 * - 错误消息只含路径/原因码/字段名等存在性信息，禁止回显凭据值（与 config.ts 同纪律）。
 */

/** codearts-bridge 统一结构化错误。 */
export class BridgeError extends Error {
  /** 稳定错误码（UPPER_SNAKE，如 BIN_MISSING_NO_BACKUP）；调用方据此编程化分支。 */
  readonly code: string;

  /** 中文修复指引（可选；用户可见文案，面向 codearts_* 工具输出）。 */
  readonly remediation?: string;

  constructor(
    code: string,
    message: string,
    options?: { remediation?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BridgeError";
    this.code = code;
    this.remediation = options?.remediation;
  }
}
