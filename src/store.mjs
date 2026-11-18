// 记录身份 = 类别 + 来源 + 申请 + （材料）。
// 取舍规则：先比审核回合，再比同回合内的修订号。
// 会员重传后晚到的旧回合页面（即使修订号更大）不会覆盖新回合状态。
function keyOf(record) {
  const parts = [record.kind, record.source, record.applicationId];
  if (record.kind === 'material') {
    parts.push(record.materialId);
  }
  return parts.join('|');
}

function isNewer(next, previous) {
  return (
    next.round > previous.round ||
    (next.round === previous.round && next.revision >= previous.revision)
  );
}

export class RecordStore {
  #records = new Map();

  save(record) {
    const key = keyOf(record);
    const previous = this.#records.get(key);
    if (!previous || isNewer(record, previous)) {
      this.#records.set(key, structuredClone(record));
    }
    return structuredClone(this.#records.get(key));
  }

  list() {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}
