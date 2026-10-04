// 设备校准：校准登记输入规整与运行放行判定（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 登记时填写「唯一校准单号 + 设备编号 + 校准时间 + 到期时间 + 合格/不合格结论」，
//     时间一律为 UTC；
//   - 校准时间须早于到期时间，且不得晚于服务端当前时刻；
//   - 同设备校准时间须晚于上一条（记录只追加，按最新一条判定）；
//   - 已有校准记录的设备，开始运行时须在原事务内确认最新结论合格，
//     且到期时间不早于本次预约终点；无记录设备沿用现有开始规则；
//   - 开始成功后冻结校准依据；之后新增记录、运行超时或完结均不改写历史；
//   - 重复单号同内容返回原记录，异内容拒绝；无效输入不留校准记录。

import { parseUtcMs, toIso } from './reserve.js';

export const CALIB_RESULTS = ['pass', 'fail'];

// 校准登记请求规整：
//   { calibNo, deviceNo, calibratedAtUtc, expiresAtUtc, result }
//   result 仅能为 pass（合格）/ fail（不合格）。
// nowMs 为服务端当前时刻（毫秒）：校准时间不得晚于该时刻。
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝，不留校准记录。
export function normalizeCalibrationInput(body, nowMs) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const calibNo = typeof b.calibNo === 'string' ? b.calibNo.trim() : '';
  if (!calibNo) errors.push('校准单号不能为空');
  else if (calibNo.length > 100) errors.push('校准单号过长（最多 100 字符）');

  const deviceNo = typeof b.deviceNo === 'string' ? b.deviceNo.trim() : '';
  if (!deviceNo) errors.push('设备编号不能为空');
  else if (deviceNo.length > 100) errors.push('设备编号过长（最多 100 字符）');

  const calibratedMs = parseUtcMs(b.calibratedAtUtc);
  if (calibratedMs === null) errors.push('校准时间不是合法的 UTC 时间（ISO 8601）');
  const expiresMs = parseUtcMs(b.expiresAtUtc);
  if (expiresMs === null) errors.push('到期时间不是合法的 UTC 时间（ISO 8601）');
  if (calibratedMs !== null && expiresMs !== null && !(calibratedMs < expiresMs)) {
    errors.push('校准时间必须早于到期时间');
  }
  if (calibratedMs !== null && Number.isFinite(nowMs) && !(calibratedMs <= nowMs)) {
    errors.push('校准时间不得晚于服务端当前时刻');
  }

  const result = b.result;
  if (typeof result !== 'string' || !CALIB_RESULTS.includes(result)) {
    errors.push(`校准结论必须是 ${CALIB_RESULTS.join(' / ')} 之一（合格 / 不合格）`);
  }

  if (errors.length) return { errors, clean: null };
  return {
    errors,
    clean: {
      calibNo,
      deviceNo,
      calibratedAtUtc: toIso(calibratedMs),
      expiresAtUtc: toIso(expiresMs),
      result,
    },
  };
}

// 运行放行判定（开始运行事务内调用）：
//   deviceNo          设备编号（仅用于错误信息）
//   latest            该设备最新一条校准记录（行对象）；null 表示无记录
//   reservationEndUtc 本次预约终点（ISO 字符串）
// 返回 { ok, errors }：
//   - 无记录：ok（沿用现有开始规则，不核对校准）；
//   - 最新结论不合格：拒绝并说明不合格；
//   - 到期时间早于本次预约终点：拒绝并说明有效期不足
//     （到期时间 == 预约终点视为「不早于」，放行）。
export function evaluateCalibrationGate({ deviceNo, latest, reservationEndUtc }) {
  if (!latest) return { ok: true, errors: [] };
  const errors = [];
  if (latest.result !== 'pass') {
    errors.push(
      `设备「${deviceNo}」最新校准记录「${latest.calib_no}」` +
        `（校准时间 ${latest.calibrated_at}）结论为不合格，不能开始运行；` +
        '须重新校准并登记合格结论后方可放行',
    );
  }
  const endMs = Date.parse(reservationEndUtc);
  const expiresMs = Date.parse(latest.expires_at);
  if (!(expiresMs >= endMs)) {
    errors.push(
      `设备「${deviceNo}」最新校准记录「${latest.calib_no}」到期时间 ${latest.expires_at} ` +
        `早于本次预约终点 ${reservationEndUtc}（校准有效期不足），不能开始运行；` +
        '须重新校准使有效期覆盖预约时段后方可放行',
    );
  }
  return { ok: errors.length === 0, errors };
}
