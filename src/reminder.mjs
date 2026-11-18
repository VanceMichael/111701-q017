// 提醒视图：把存储里的记录按 会员 → 申请 聚合，算出每个申请当前仍缺的材料。
// 通知服务只消费这份视图，因此对同一会员的表述始终来自同一快照，不会自相矛盾：
// - 已补齐（新回合变为非缺件状态）的材料不再列出；
// - 申请进入终态（通过/驳回/撤回）且回合不旧于材料记录时，旧缺件不再催办；
// - 材料明细落后于申请最新回合时标记 stale，提示需要重新抓取而非直接断言缺件。

// 缺件类状态：需要催办的材料状态。
const DEFICIENT_STATES = new Set(['missing', 'returned']);
// 终态：申请不再等待补材料，旧回合的缺件记录不再构成催办依据。
const NON_ACTIONABLE_STATES = new Set(['approved', 'rejected', 'withdrawn']);

// 同一申请/材料可能被多个门户（来源）报告，按 回合 → 修订号 → 观察时间 取最新，
// 以来源名做确定性兜底，保证视图可复现。
function compareRecency(a, b) {
  return (
    a.round - b.round ||
    a.revision - b.revision ||
    String(a.observedAt ?? '').localeCompare(String(b.observedAt ?? '')) ||
    a.source.localeCompare(b.source)
  );
}

export function buildReminders(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.memberId} ${record.applicationId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        memberId: record.memberId,
        applicationId: record.applicationId,
        summaries: [],
        materials: new Map(),
      };
      groups.set(key, group);
    }
    if (record.kind === 'application') {
      group.summaries.push(record);
    } else {
      const previous = group.materials.get(record.materialId);
      if (!previous || compareRecency(record, previous) >= 0) {
        group.materials.set(record.materialId, record);
      }
    }
  }

  const members = new Map();
  for (const group of groups.values()) {
    const summary = group.summaries.length
      ? group.summaries.reduce((a, b) => (compareRecency(a, b) >= 0 ? a : b))
      : null;
    const materials = [...group.materials.values()];
    const round = Math.max(
      0,
      ...group.summaries.map((record) => record.round),
      ...materials.map((record) => record.round),
    );
    const terminal = summary && NON_ACTIONABLE_STATES.has(summary.state) ? summary : null;
    const missing = materials
      .filter((record) => DEFICIENT_STATES.has(record.state))
      .filter((record) => !terminal || terminal.round < record.round)
      .map((record) => ({
        materialId: record.materialId,
        state: record.state,
        round: record.round,
        comment: record.comment ?? null,
        source: record.source,
      }))
      .sort((a, b) => a.materialId.localeCompare(b.materialId));

    let member = members.get(group.memberId);
    if (!member) {
      member = { memberId: group.memberId, applications: [] };
      members.set(group.memberId, member);
    }
    member.applications.push({
      applicationId: group.applicationId,
      round,
      state: summary ? summary.state : null,
      stale: missing.some((item) => item.round < round),
      missing,
    });
  }

  return [...members.values()]
    .map((member) => ({
      memberId: member.memberId,
      hasOutstanding: member.applications.some((view) => view.missing.length > 0),
      applications: member.applications.sort((a, b) =>
        a.applicationId.localeCompare(b.applicationId),
      ),
    }))
    .sort((a, b) => a.memberId.localeCompare(b.memberId));
}
