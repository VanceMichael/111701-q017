// 将两种门户页面形态规整为统一记录：
// - 仅总状态页：只有 application.state，产出一条 application 记录；
// - 逐份明细页：带有 materials 列表，每份材料产出一条 material 记录。
// 每条记录都携带所属申请（applicationId）、会员（memberId）和审核回合（round），
// 供存储层按回合取舍、提醒服务按申请聚合。
export function normalizePage(page) {
  const application = page?.application;
  const applicationId = String(application?.id ?? '').trim();
  const memberId = String(application?.memberId ?? '').trim();
  if (!applicationId || !memberId || application?.round == null) {
    throw new Error('页面缺少 application 的 id、memberId 或 round');
  }
  const round = Number(application.round);
  if (!Number.isFinite(round) || round < 0) {
    throw new Error('application.round 不是有效数字');
  }

  const base = {
    source: String(page.source ?? ''),
    memberId,
    applicationId,
    round,
    observedAt: page.observedAt ?? null,
  };
  const records = [];

  if (application.state != null && String(application.state).trim() !== '') {
    records.push({
      ...base,
      kind: 'application',
      state: String(application.state),
      revision: toRevision(application.revision),
    });
  }

  if (page.materials != null) {
    if (!Array.isArray(page.materials)) {
      throw new Error('materials 不是数组');
    }
    for (const item of page.materials) {
      const materialId = String(item?.id ?? '').trim();
      if (!materialId || item?.state == null || String(item.state).trim() === '') {
        throw new Error('材料记录缺少 id 或 state');
      }
      records.push({
        ...base,
        kind: 'material',
        materialId,
        state: String(item.state),
        comment: item.comment == null ? null : String(item.comment),
        revision: toRevision(item.revision ?? application.revision),
      });
    }
  }

  if (records.length === 0) {
    throw new Error('页面既没有申请状态也没有材料列表');
  }
  return records;
}

function toRevision(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
