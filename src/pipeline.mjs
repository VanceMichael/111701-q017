import { normalizePage } from './adapter.mjs';
import { buildReminders } from './reminder.mjs';
import { readSource } from './source.mjs';
import { RecordStore } from './store.mjs';

// 兼容三种来源返回：批次（{ source, pages }）、页面数组、单个页面。
// 批次级 source / observedAt 作为页面的缺省值，页面自身字段优先。
function coercePages(batch) {
  if (Array.isArray(batch)) {
    return batch;
  }
  if (batch && typeof batch === 'object' && Array.isArray(batch.pages)) {
    return batch.pages.map((page) => ({
      source: batch.source,
      observedAt: batch.observedAt,
      ...page,
    }));
  }
  return [batch];
}

export async function collect({ source = readSource, store = new RecordStore() } = {}) {
  const batch = await source();
  const records = [];
  const failures = [];
  for (const page of coercePages(batch)) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) {
      failures.push({ source: null, observedAt: null, error: '页面不是对象' });
      continue;
    }
    if (page.error != null) {
      // 抓取失败只登记失败，不触碰既有记录：失败不代表材料被删除。
      failures.push({
        source: page.source ?? null,
        observedAt: page.observedAt ?? null,
        error: String(page.error),
      });
      continue;
    }
    try {
      for (const record of normalizePage(page)) {
        records.push(store.save(record));
      }
    } catch (error) {
      // 单页畸形不中断整批，避免高峰期一个坏页面丢掉其他门户的数据。
      failures.push({
        source: page.source ?? null,
        observedAt: page.observedAt ?? null,
        error: error.message,
      });
    }
  }
  return {
    source: batch?.source ?? null,
    observedAt: batch?.observedAt ?? null,
    records,
    failures,
    reminders: buildReminders(store.list()),
    store,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await collect();
  console.log(
    JSON.stringify(
      {
        source: result.source,
        records: result.records.length,
        failures: result.failures,
        reminders: result.reminders,
      },
      null,
      2,
    ),
  );
}
